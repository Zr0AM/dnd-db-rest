import { Context } from 'hono';
import type { Env } from './index';

type RestContext = Context<{ Bindings: Env }>;

/**
 * Primary-key column per table, used by the by-id routes
 * (GET/PATCH/PUT/DELETE /rest/{table}/{id}).
 * Keys are lower-case table names (SQLite table names are case-insensitive).
 * Tables that are not listed here use a column named `id`.
 */
const PRIMARY_KEYS: Record<string, string> = {
    item: 'itemID',
};

function primaryKeyFor(tableName: string): string {
    return PRIMARY_KEYS[sanitizeIdentifier(tableName).toLowerCase()] ?? 'id';
}

/**
 * Sanitizes an identifier by removing all non-alphanumeric characters except underscores.
 */
function sanitizeIdentifier(identifier: string): string {
    return identifier.replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Processing when the table name is a keyword in SQLite.
 */
function sanitizeKeyword(identifier: string): string {
    return '`'+sanitizeIdentifier(identifier)+'`';
}

/**
 * Consistent error body: { success: false, error }.
 * Successful responses are D1's raw result object and are not changed.
 */
function errorResponse(c: RestContext, message: string, status: 400 | 405 | 500): Response {
    return c.json({ success: false, error: message }, status);
}

/**
 * Parses a non-negative integer query parameter.
 * Returns undefined when the parameter is absent/empty, null when it is invalid.
 */
function parseNonNegativeInt(value: string | null): number | undefined | null {
    if (value === null || value === '') return undefined;
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parses the optional `fields=a,b,c` parameter into a list of column names.
 * Returns undefined when absent, null when empty or containing invalid identifiers.
 */
function parseFields(value: string | null): string[] | undefined | null {
    if (value === null) return undefined;
    const requested = value.split(',').map(f => f.trim()).filter(Boolean);
    if (requested.length === 0) return null;
    const columns = requested.map(sanitizeIdentifier);
    if (columns.some((col, i) => col !== requested[i])) return null;
    return [...new Set(columns)];
}

/**
 * Reads the request body as a non-empty JSON object.
 * Returns an error Response when the body is not valid.
 */
async function readJsonObject(c: RestContext): Promise<Record<string, unknown> | Response> {
    let data: unknown;
    try {
        data = await c.req.json();
    } catch {
        return errorResponse(c, 'Invalid JSON body', 400);
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return errorResponse(c, 'Invalid data format', 400);
    }
    const entries = Object.keys(data);
    if (entries.length === 0) {
        return errorResponse(c, 'No fields provided', 400);
    }
    if (entries.some(key => sanitizeIdentifier(key) === '')) {
        return errorResponse(c, 'Invalid column name', 400);
    }
    return data as Record<string, unknown>;
}

/**
 * Handles GET requests to fetch records from a table
 */
async function handleGet(c: RestContext, tableName: string, id?: string): Promise<Response> {
    const table = sanitizeKeyword(tableName);
    const searchParams = new URL(c.req.url).searchParams;

    const fields = parseFields(searchParams.get('fields'));
    if (fields === null) {
        return errorResponse(c, 'Invalid fields. Expected a comma-separated list of column names', 400);
    }

    const limit = parseNonNegativeInt(searchParams.get('limit'));
    if (limit === null) {
        return errorResponse(c, 'Invalid limit. Expected a non-negative integer', 400);
    }
    const offset = parseNonNegativeInt(searchParams.get('offset'));
    if (offset === null) {
        return errorResponse(c, 'Invalid offset. Expected a non-negative integer', 400);
    }

    try {
        let query = `SELECT ${fields ? fields.join(', ') : '*'} FROM ${table}`;
        const params: any[] = [];
        const conditions: string[] = [];

        // Handle ID filter
        if (id) {
            conditions.push(`${primaryKeyFor(tableName)} = ?`);
            params.push(id);
        }

        // Handle search parameters (basic filtering)
        for (const [key, value] of searchParams.entries()) {
            if (['sort_by', 'order', 'limit', 'offset', 'fields'].includes(key)) continue;

            const sanitizedKey = sanitizeIdentifier(key);
            conditions.push(`${sanitizedKey} = ?`);
            params.push(value);
        }

        // Add WHERE clause if there are conditions
        if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        // Handle sorting
        const sortBy = searchParams.get('sort_by');
        if (sortBy) {
            const order = searchParams.get('order')?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
            query += ` ORDER BY ${sanitizeIdentifier(sortBy)} ${order}`;
        }

        // Handle pagination (SQLite only accepts OFFSET after a LIMIT, -1 means "no limit")
        if (limit !== undefined) {
            query += ` LIMIT ?`;
            params.push(limit);
        } else if (offset !== undefined) {
            query += ` LIMIT -1`;
        }
        if (offset !== undefined) {
            query += ` OFFSET ?`;
            params.push(offset);
        }

        const results = await c.env.DB.prepare(query)
            .bind(...params)
            .all();

        return c.json(results);
    } catch (error: any) {
        return errorResponse(c, error.message, 500);
    }
}

/**
 * Handles POST requests to create new records
 */
async function handlePost(c: RestContext, tableName: string): Promise<Response> {
    const table = sanitizeKeyword(tableName);

    try {
        const data = await readJsonObject(c);
        if (data instanceof Response) return data;

        const entries = Object.entries(data);
        const columns = entries.map(([key]) => sanitizeIdentifier(key));
        const placeholders = columns.map(() => '?').join(', ');
        const query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
        const params = entries.map(([, value]) => value);

        const result = await c.env.DB.prepare(query)
            .bind(...params)
            .run();

        return c.json({ message: 'Resource created successfully', data }, 201);
    } catch (error: any) {
        return errorResponse(c, error.message, 500);
    }
}

/**
 * Handles PUT/PATCH requests to update records
 */
async function handleUpdate(c: RestContext, tableName: string, id: string): Promise<Response> {
    const table = sanitizeKeyword(tableName);

    try {
        const data = await readJsonObject(c);
        if (data instanceof Response) return data;

        const setColumns = Object.keys(data)
            .map(sanitizeIdentifier)
            .map(col => `${col} = ?`)
            .join(', ');

        const query = `UPDATE ${table} SET ${setColumns} WHERE ${primaryKeyFor(tableName)} = ?`;
        const params = [...Object.values(data), id];

        const result = await c.env.DB.prepare(query)
            .bind(...params)
            .run();

        return c.json({ message: 'Resource updated successfully', data });
    } catch (error: any) {
        return errorResponse(c, error.message, 500);
    }
}

/**
 * Handles DELETE requests to remove records
 */
async function handleDelete(c: RestContext, tableName: string, id: string): Promise<Response> {
    const table = sanitizeKeyword(tableName);

    try {
        const query = `DELETE FROM ${table} WHERE ${primaryKeyFor(tableName)} = ?`;
        const result = await c.env.DB.prepare(query)
            .bind(id)
            .run();

        return c.json({ message: 'Resource deleted successfully' });
    } catch (error: any) {
        return errorResponse(c, error.message, 500);
    }
}

/**
 * Main REST handler that routes requests to appropriate handlers
 */
export async function handleRest(c: RestContext): Promise<Response> {
    const url = new URL(c.req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    if (pathParts.length < 2) {
        return errorResponse(c, 'Invalid path. Expected format: /rest/{tableName}/{id?}', 400);
    }

    const tableName = pathParts[1];
    const id = pathParts[2];

    switch (c.req.method) {
        case 'GET':
            return handleGet(c, tableName, id);
        case 'POST':
            return handlePost(c, tableName);
        case 'PUT':
        case 'PATCH':
            if (!id) return errorResponse(c, 'ID is required for updates', 400);
            return handleUpdate(c, tableName, id);
        case 'DELETE':
            if (!id) return errorResponse(c, 'ID is required for deletion', 400);
            return handleDelete(c, tableName, id);
        default:
            return errorResponse(c, 'Method not allowed', 405);
    }
}
