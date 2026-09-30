import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { handleRest } from './rest';

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
    // Secret Store key value that we have set
    const secret = await c.env.SECRET.get();

    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
        return unauthorized(c);
    }

    const token = authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : authHeader;

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

// Execute a raw SQL statement with parameters with this route
app.post('/query', authMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const {query, params} = body;

        if (!query) {
            return c.json({error: 'Query is required'}, 400);
        }

        // Execute the query against D1 database
        const results = await c.env.DB.prepare(query)
            .bind(...(params || []))
            .all();

        return c.json(results);
    } catch (error: any) {
        return c.json({error: error.message}, 500);
    }
});

export default app;
