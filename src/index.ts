import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { handleRest } from './rest';
import { isReadOnlyQuery } from './sql-guard';

export interface Env {
    DB: D1Database;
    SECRET: SecretsStoreSecret;
}

// # List all items (the active flag is stored as 0/1)
// GET /rest/Item?active=1

// # List items without the long description text, sorted and paginated
// GET /rest/Item?active=1&fields=itemID,itemName,itemRarity,itemCost&sort_by=itemName&order=asc&limit=50&offset=100

// # Get one item (by its primary key, itemID) including the description
// GET /rest/Item/42
// GET /rest/Item/42?fields=itemID,itemName,itemDescription

// # Create an item (itemID is not auto-generated, the client must supply it)
// POST /rest/Item
// { "itemID": 2000, "itemName": "Bag of Holding", "itemRarity": "Uncommon", "itemCost": 500 }

// # Update an item
// PATCH /rest/Item/42
// { "itemCost": 750 }

// # Delete an item
// DELETE /rest/Item/42

const app = new Hono<{ Bindings: Env }>();

// Apply CORS to all routes
app.use('*', async (c, next) => {
    return cors()(c, next);
})

const isBindable = (v: unknown) =>
    v === null || ['string', 'number', 'boolean'].includes(typeof v);

const unauthorized = (c: Context) => c.json({success: false, error: 'Unauthorized'}, 401);

// Constant-time string comparison. Both values are hashed first so the
// comparison always runs over equal-length buffers and does not leak the
// length of the secret.
const safeEqual = async (a: string, b: string): Promise<boolean> => {
    const encoder = new TextEncoder();
    const [hashA, hashB] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(a)),
        crypto.subtle.digest('SHA-256', encoder.encode(b)),
    ]);
    return crypto.subtle.timingSafeEqual(hashA, hashB);
};

// Authentication middleware that verifies the Authorization header
// is sent in on each request and matches the value of our Secret key.
// If a match is not found we return a 401 and prevent further access.
const authMiddleware = async (c: Context, next: Next) => {
    // Check the request first so unauthenticated calls never reach the Secrets Store
    const authHeader = c.req.header('Authorization')?.trim();
    if (!authHeader) {
        return unauthorized(c);
    }

    // `Bearer <token>` (scheme is case-insensitive) or the bare token
    const token = authHeader.replace(/^bearer(\s+|$)/i, '').trim();
    if (!token) {
        return unauthorized(c);
    }

    // Secret Store key value that we have set. A failure here propagates to onError (500).
    const secret = await c.env.SECRET.get();
    if (!secret) {
        console.error('The API secret is empty or missing');
        return c.json({success: false, error: 'Server misconfigured'}, 500);
    }

    if (!(await safeEqual(token, secret))) {
        return unauthorized(c);
    }

    return next();
};

// Add a root endpoint
app.get('/', (c) => {
    return c.json({status: 'ok', service: 'dnd-db-rest'});
});

// CRUD REST endpoints made available to all of our tables
app.all('/rest/*', authMiddleware, handleRest);

// Execute a raw READ-ONLY SQL statement (SELECT / WITH) with parameters with this route.
// Writes and DDL are refused: use `wrangler d1 execute` for those.
app.post('/query', authMiddleware, async (c) => {
    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return c.json({success: false, error: 'Invalid JSON body'}, 400);
    }
    const query = body?.query;
    const params = body?.params ?? [];

    if (typeof query !== 'string' || !query.trim()) {
        return c.json({success: false, error: 'Query is required'}, 400);
    }
    if (!Array.isArray(params) || !params.every(isBindable)) {
        return c.json({success: false, error: 'params must be an array of strings, numbers, booleans or null'}, 400);
    }

    if (!isReadOnlyQuery(query)) {
        return c.json({success: false, error: 'Only read-only queries are allowed'}, 403);
    }

    try {
        // Execute the query against D1 database
        const results = await c.env.DB.prepare(query)
            .bind(...params.map((v: unknown) => typeof v === 'boolean' ? Number(v) : v))
            .all();

        return c.json(results);
    } catch (error: any) {
        // Usually a mistake in the SQL: log the detail, do not echo raw database text
        console.error('Query failed:', error?.message);
        return c.json({success: false, error: 'Query could not be executed'}, 400);
    }
});

// Unknown routes and unexpected errors use the same JSON error shape as everything else
app.notFound((c) => c.json({success: false, error: 'Not found'}, 404));
app.onError((error, c) => {
    console.error('Unhandled error:', error);
    return c.json({success: false, error: 'Internal server error'}, 500);
});

export default app;
