import { Context } from 'hono';
import type { Env } from './index';

type RestContext = Context<{ Bindings: Env }>;

/**
 * Tables exposed through /rest/{table}, each with its primary-key column (used by the
 * by-id routes GET/PATCH/PUT/DELETE /rest/{table}/{id}).
 *
 * This is an ALLOWLIST: every other table (sqlite_master, d1_migrations, _cf_*, ...)
 * answers 404 and can be neither read nor written. The keys are the exact table names
 * used in SQL; the URL is matched case-insensitively (SQLite table names are).
 * Primary keys are integers that the client supplies (they are required on POST).
 * `readOnly` tables (and views) answer 405 to anything but GET.
 */
export const TABLES: Record<string, { primaryKey: string; readOnly?: boolean }> = {
    Item: { primaryKey: 'itemID' },
    // SRD game data: list views for browsing, base tables for full detail by id.
    SpellListView: { primaryKey: 'spellID', readOnly: true },
    MonsterListView: { primaryKey: 'monsterID', readOnly: true },
    EquipmentListView: { primaryKey: 'equipmentID', readOnly: true },
    Spell: { primaryKey: 'spellID', readOnly: true },
    Monster: { primaryKey: 'monsterID', readOnly: true },
    Equipment: { primaryKey: 'equipmentID', readOnly: true },
};

/** `limit` applied when the request has none, and the largest `limit` accepted. */
export const DEFAULT_LIMIT = 2000;
export const MAX_LIMIT = 5000;

/** Query parameters that are never treated as column filters (matched case-insensitively). */
const RESERVED_PARAMS = new Set(['sort_by', 'order', 'limit', 'offset', 'fields']);

type ErrorStatus = 400 | 404 | 405 | 409 | 422 | 500;
type Bindable = string | number | null;

/**
 * Sanitizes an identifier by removing all non-alphanumeric characters except underscores.
 * It is only used to DETECT names that contain other characters: such names are rejected,
 * never silently rewritten.
 */
function sanitizeIdentifier(identifier: string): string {
    return identifier.replace(/[^a-zA-Z0-9_]/g, '');
}

function isValidName(name: string): boolean {
    return name !== '' && sanitizeIdentifier(name) === name;
}

/** Double-quotes an identifier that has already been validated (so keywords such as `select` work). */
function quote(name: string): string {
    return `"${name}"`;
}

/**
 * Consistent error body: { success: false, error }.
 * Successful responses are D1's raw result object and are not changed.
 */
function errorResponse(c: RestContext, message: string, status: ErrorStatus): Response {
    return c.json({ success: false, error: message }, status);
}

/**
 * Maps a database failure to a client-safe response. Constraint violations are the
 * client's fault (409 / 422); anything else is logged and returned as a generic 500 so
 * raw SQLite text never reaches the client.
 */
function databaseError(c: RestContext, error: unknown): Response {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
        return errorResponse(c, 'Duplicate value: a row with this key already exists', 409);
    }
    if (/constraint failed|SQLITE_CONSTRAINT/i.test(message)) {
        return errorResponse(c, 'Value violates a table constraint', 422);
    }
    console.error('Database error:', message);
    return errorResponse(c, 'Internal server error', 500);
}

/**
 * Real columns per table (name -> declared type), read once per isolate with
 * PRAGMA table_info. Keyed by lower-case table name.
 */
const columnCache = new Map<string, Map<string, string>>();

async function loadColumns(db: D1Database, table: string): Promise<Map<string, string>> {
    const { results } = await db.prepare(`PRAGMA table_info(${quote(table)})`).all<{ name: string; type: string }>();
    const columns = new Map(results.map(r => [r.name, r.type] as [string, string]));
    columnCache.set(table.toLowerCase(), columns);
    return columns;
}

/**
 * Looks up the table's columns and returns the first requested name that is not one of
 * them (or undefined). The cached column list is refreshed once on a miss, so a column
 * added by a migration is picked up without waiting for the isolate to be recycled.
 */
async function checkColumns(
    db: D1Database,
    table: string,
    names: string[]
): Promise<{ columns: Map<string, string>; unknown?: string }> {
    let columns = columnCache.get(table.toLowerCase()) ?? await loadColumns(db, table);
    let unknown = names.find(name => !columns.has(name));
    if (unknown !== undefined) {
        columns = await loadColumns(db, table);
        unknown = names.find(name => !columns.has(name));
    }
    return { columns, unknown };
}

/**
 * Parses a non-negative integer query parameter.
 * Returns undefined when the parameter is absent/empty, null when it is invalid.
 */
function parseNonNegativeInt(value: string | undefined): number | undefined | null {
    if (value === undefined || value === '') return undefined;
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
}

/** Parses a primary-key value from a URL (strict: optional minus sign and digits only). */
function parseKeyValue(value: string): number | null {
    if (!/^-?\d+$/.test(value)) return null;
    const n = Number(value);
    // `|| 0` turns -0 into 0
    return Number.isSafeInteger(n) ? (n || 0) : null;
}

/**
 * Parses the optional `fields=a,b,c` parameter into a list of column names.
 * Returns undefined when absent, null when empty or containing invalid identifiers.
 */
function parseFields(value: string | undefined): string[] | undefined | null {
    if (value === undefined) return undefined;
    const requested = value.split(',').map(f => f.trim()).filter(Boolean);
    if (requested.length === 0) return null;
    if (!requested.every(isValidName)) return null;
    return [...new Set(requested)];
}

/** JSON body values that can be stored: string, finite number, boolean or null. */
function toBindable(value: unknown): Bindable | undefined {
    if (value === null || typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return undefined;
}

type WriteBody = { data: Record<string, unknown>; columns: string[]; values: Bindable[] };

/**
 * Reads and validates the request body: a non-empty JSON object whose keys are valid
 * column names (not rewritten) and whose values are strings, finite numbers, booleans
 * or null. Returns an error Response when the body is not valid.
 */
async function readWriteBody(c: RestContext): Promise<WriteBody | Response> {
    let data: unknown;
    try {
        data = await c.req.json();
    } catch {
        return errorResponse(c, 'Invalid JSON body', 400);
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return errorResponse(c, 'Invalid data format', 400);
    }
    const object = data as Record<string, unknown>;
    const columns = Object.keys(object);
    if (columns.length === 0) {
        return errorResponse(c, 'No fields provided', 400);
    }
    if (!columns.every(isValidName)) {
        return errorResponse(c, 'Invalid column name', 400);
    }
    const values: Bindable[] = [];
    for (const column of columns) {
        const value = toBindable(object[column]);
        if (value === undefined) {
            return errorResponse(c, `Invalid value for column: ${column}. Expected a string, number, boolean or null`, 400);
        }
        values.push(value);
    }
    return { data: object, columns, values };
}

/**
 * Checks the body's columns against the table: every column must exist, and columns with
 * INTEGER affinity (declared type contains "INT") only take whole numbers (or numeric
 * text), so `{"itemCost": "abc"}` is refused instead of being stored as text.
 */
async function validateColumns(c: RestContext, table: string, body: WriteBody): Promise<Response | undefined> {
    const { columns, unknown } = await checkColumns(c.env.DB, table, body.columns);
    if (unknown !== undefined) {
        return errorResponse(c, `Unknown column: ${unknown}`, 400);
    }
    for (let i = 0; i < body.columns.length; i++) {
        const column = body.columns[i];
        const value = body.values[i];
        if (value === null || !/int/i.test(columns.get(column) ?? '')) continue;
        const whole = typeof value === 'number'
            ? Number.isSafeInteger(value)
            : /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value));
        if (!whole) {
            return errorResponse(c, `Invalid value for column: ${column}. Expected an integer`, 400);
        }
    }
    return undefined;
}

/** The primary key in a body must be a (safe) integer, never null, text or a float. */
function isValidKeyValue(value: unknown): boolean {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Handles GET requests to fetch records from a table
 */
async function handleGet(c: RestContext, table: string, primaryKey: string, id?: number): Promise<Response> {
    // Reserved parameters are matched case-insensitively; everything else is an equality filter.
    const reserved: Record<string, string> = {};
    const filters: [string, string][] = [];
    for (const [key, value] of new URL(c.req.url).searchParams.entries()) {
        const lower = key.toLowerCase();
        if (RESERVED_PARAMS.has(lower)) {
            if (lower in reserved) return errorResponse(c, `Duplicate parameter: ${lower}`, 400);
            reserved[lower] = value;
        } else {
            filters.push([key, value]);
        }
    }

    const fields = parseFields(reserved.fields);
    if (fields === null) {
        return errorResponse(c, 'Invalid fields. Expected a comma-separated list of column names', 400);
    }

    const limit = parseNonNegativeInt(reserved.limit);
    if (limit === null) {
        return errorResponse(c, 'Invalid limit. Expected a non-negative integer', 400);
    }
    if (limit !== undefined && limit > MAX_LIMIT) {
        return errorResponse(c, `Invalid limit. The maximum is ${MAX_LIMIT}`, 400);
    }
    const offset = parseNonNegativeInt(reserved.offset);
    if (offset === null) {
        return errorResponse(c, 'Invalid offset. Expected a non-negative integer', 400);
    }

    const sortBy = reserved.sort_by || undefined;
    if (sortBy !== undefined && !isValidName(sortBy)) {
        return errorResponse(c, 'Invalid parameter name', 400);
    }

    const conditions: { column: string; value: Bindable }[] = [];
    if (id !== undefined) {
        conditions.push({ column: primaryKey, value: id });
    }
    for (const [key, value] of filters) {
        if (!isValidName(key)) {
            return errorResponse(c, 'Invalid parameter name', 400);
        }
        if (key === primaryKey) {
            const keyValue = parseKeyValue(value);
            if (keyValue === null) {
                return errorResponse(c, `Invalid ${key}. Expected an integer`, 400);
            }
            conditions.push({ column: key, value: keyValue });
        } else {
            conditions.push({ column: key, value });
        }
    }

    try {
        const requested = [...(fields ?? []), ...(sortBy ? [sortBy] : []), ...filters.map(([key]) => key)];
        const { unknown } = await checkColumns(c.env.DB, table, requested);
        if (unknown !== undefined) {
            return errorResponse(c, `Unknown column: ${unknown}`, 400);
        }

        let query = `SELECT ${fields ? fields.map(quote).join(', ') : '*'} FROM ${quote(table)}`;
        const params: Bindable[] = [];

        if (conditions.length > 0) {
            query += ` WHERE ${conditions.map(({ column }) => `${quote(column)} = ?`).join(' AND ')}`;
            params.push(...conditions.map(({ value }) => value));
        }

        if (sortBy !== undefined) {
            const order = reserved.order?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
            query += ` ORDER BY ${quote(sortBy)} ${order}`;
        }

        // A LIMIT is always present (SQLite only accepts OFFSET after a LIMIT)
        query += ` LIMIT ?`;
        params.push(limit ?? DEFAULT_LIMIT);
        if (offset !== undefined) {
            query += ` OFFSET ?`;
            params.push(offset);
        }

        const results = await c.env.DB.prepare(query)
            .bind(...params)
            .all();

        return c.json(results);
    } catch (error) {
        return databaseError(c, error);
    }
}

/**
 * Handles POST requests to create new records
 */
async function handlePost(c: RestContext, table: string, primaryKey: string): Promise<Response> {
    const body = await readWriteBody(c);
    if (body instanceof Response) return body;

    // The primary key is not auto-generated: a row without one would be unreachable
    if (!(primaryKey in body.data)) {
        return errorResponse(c, `Missing primary key: ${primaryKey}`, 400);
    }
    if (!isValidKeyValue(body.data[primaryKey])) {
        return errorResponse(c, `Invalid ${primaryKey}. Expected an integer`, 400);
    }

    try {
        const invalid = await validateColumns(c, table, body);
        if (invalid) return invalid;

        const placeholders = body.columns.map(() => '?').join(', ');
        const query = `INSERT INTO ${quote(table)} (${body.columns.map(quote).join(', ')}) VALUES (${placeholders})`;

        await c.env.DB.prepare(query)
            .bind(...body.values)
            .run();

        return c.json({ message: 'Resource created successfully', data: body.data }, 201);
    } catch (error) {
        return databaseError(c, error);
    }
}

/**
 * Handles PUT/PATCH requests to update records
 */
async function handleUpdate(c: RestContext, table: string, primaryKey: string, id: number): Promise<Response> {
    const body = await readWriteBody(c);
    if (body instanceof Response) return body;

    if (primaryKey in body.data && !isValidKeyValue(body.data[primaryKey])) {
        return errorResponse(c, `Invalid ${primaryKey}. Expected an integer`, 400);
    }

    try {
        const invalid = await validateColumns(c, table, body);
        if (invalid) return invalid;

        const assignments = body.columns.map(column => `${quote(column)} = ?`).join(', ');
        const query = `UPDATE ${quote(table)} SET ${assignments} WHERE ${quote(primaryKey)} = ?`;

        const result = await c.env.DB.prepare(query)
            .bind(...body.values, id)
            .run();

        if (result.meta.changes === 0) {
            return errorResponse(c, 'Not found', 404);
        }
        return c.json({ message: 'Resource updated successfully', data: body.data });
    } catch (error) {
        return databaseError(c, error);
    }
}

/**
 * Handles DELETE requests to remove records
 */
async function handleDelete(c: RestContext, table: string, primaryKey: string, id: number): Promise<Response> {
    try {
        const query = `DELETE FROM ${quote(table)} WHERE ${quote(primaryKey)} = ?`;
        const result = await c.env.DB.prepare(query)
            .bind(id)
            .run();

        if (result.meta.changes === 0) {
            return errorResponse(c, 'Not found', 404);
        }
        return c.json({ message: 'Resource deleted successfully' });
    } catch (error) {
        return databaseError(c, error);
    }
}

/** Finds an allowlisted table by name, case-insensitively. Returns its exact name and key. */
function findTable(name: string): { table: string; primaryKey: string; readOnly: boolean } | undefined {
    const lower = name.toLowerCase();
    const table = Object.keys(TABLES).find(key => key.toLowerCase() === lower);
    return table === undefined
        ? undefined
        : { table, primaryKey: TABLES[table].primaryKey, readOnly: TABLES[table].readOnly === true };
}

/**
 * Main REST handler that routes requests to appropriate handlers
 */
export async function handleRest(c: RestContext): Promise<Response> {
    // /rest/{table}/{id?} (one trailing slash is tolerated; empty or extra segments are 404)
    const segments = new URL(c.req.url).pathname.split('/').slice(1);
    if (segments[segments.length - 1] === '') segments.pop();

    if (segments.length < 2) {
        return errorResponse(c, 'Invalid path. Expected format: /rest/{tableName}/{id?}', 400);
    }
    if (segments.length > 3 || segments.some(segment => segment === '')) {
        return errorResponse(c, 'Not found', 404);
    }

    let tableName: string;
    let idSegment: string | undefined;
    try {
        tableName = decodeURIComponent(segments[1]);
        idSegment = segments[2] === undefined ? undefined : decodeURIComponent(segments[2]);
    } catch {
        return errorResponse(c, 'Invalid URL encoding', 400);
    }

    const found = /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName) ? findTable(tableName) : undefined;
    if (!found) {
        return errorResponse(c, 'Not found', 404);
    }
    const { table, primaryKey, readOnly } = found;

    if (readOnly && c.req.method !== 'GET') {
        const response = errorResponse(c, 'Method not allowed', 405);
        response.headers.set('Allow', 'GET');
        return response;
    }

    let id: number | undefined;
    if (idSegment !== undefined) {
        const parsed = parseKeyValue(idSegment);
        if (parsed === null) {
            return errorResponse(c, 'Invalid id. Expected an integer', 400);
        }
        id = parsed;
    }

    switch (c.req.method) {
        case 'GET':
            return handleGet(c, table, primaryKey, id);
        case 'POST':
            if (id !== undefined) return errorResponse(c, 'POST does not take an id', 400);
            return handlePost(c, table, primaryKey);
        case 'PUT':
        case 'PATCH':
            if (id === undefined) return errorResponse(c, 'ID is required for updates', 400);
            return handleUpdate(c, table, primaryKey, id);
        case 'DELETE':
            if (id === undefined) return errorResponse(c, 'ID is required for deletion', 400);
            return handleDelete(c, table, primaryKey, id);
        default:
            return errorResponse(c, 'Method not allowed', 405);
    }
}
