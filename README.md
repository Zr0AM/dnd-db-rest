# dnd-db-rest

The data API behind Adventurer's Ledger, a D&D magic-item marketplace. It is a small
Cloudflare Worker (Hono) that exposes a token-protected REST API over a Cloudflare D1
(SQLite) database named `dnd-db`. The main table is `Item`, the catalogue of magic items
(1,393 rows at the time of writing).

- Runtime: Cloudflare Workers, Hono, D1 binding `DB`, Secrets Store binding `SECRET`
- Code: `src/index.ts` (routing, CORS, auth), `src/rest.ts` (generic CRUD handlers)
- Custom domain: `dnd-service.omnomnom.org` (see `wrangler.jsonc`)

## Quick start

```bash
# List active items, without the long description text
curl 'https://dnd-service.omnomnom.org/rest/Item?active=1&fields=itemID,itemName,itemRarity,itemCost' \
  --header 'Authorization: Bearer <YOUR-SECRET-VALUE>'

# Fetch a single item, including its description
curl 'https://dnd-service.omnomnom.org/rest/Item/42' \
  --header 'Authorization: Bearer <YOUR-SECRET-VALUE>'
```

## Authentication

Every route under `/rest/*` and `/query` requires the shared secret, either as a Bearer
token or as the bare value of the `Authorization` header:

```
Authorization: Bearer <YOUR-SECRET-VALUE>
```

The secret lives in the Cloudflare Secrets Store (`dnd-db-rest-secret`) and is compared in
constant time. A missing or wrong token returns `401`. `GET /` is an open status check.

## REST endpoints

`{table}` is a table name; the table is used as given (only letters, digits and `_` are kept).
`{id}` is the value of the table's primary key.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/rest/{table}` | List rows, with filters, sorting, pagination, projection |
| GET | `/rest/{table}/{id}` | Get one row by primary key (returns a `results` array with 0 or 1 row) |
| POST | `/rest/{table}` | Insert a row from a JSON object (`201`) |
| PATCH / PUT | `/rest/{table}/{id}` | Update the given columns of a row (both behave the same: a partial update) |
| DELETE | `/rest/{table}/{id}` | Delete a row |
| POST | `/query` | Raw parameterised SQL (see Security notes) |

### Primary key

By-id routes (GET, PATCH, PUT, DELETE) use a per-table primary-key column, defined in the
`PRIMARY_KEYS` map in `src/rest.ts`:

| Table | Primary key |
|-------|-------------|
| `Item` | `itemID` |
| any other table | `id` |

So `GET /rest/Item/42` runs `SELECT * FROM Item WHERE itemID = ?`. To support a new table
whose key is not `id`, add it to `PRIMARY_KEYS` (use a lower-case table name as the key).

`itemID` is declared `int ... primary key`, which in SQLite is **not** an auto-incrementing
rowid alias. Clients must supply `itemID` when creating an item.

### Query parameters (GET)

| Parameter | Description | Example |
|-----------|-------------|---------|
| `fields` | Comma-separated columns to return instead of `*`. Works on list and by-id. An empty or invalid list returns `400`. | `fields=itemID,itemName` |
| `sort_by` | Column to sort by | `sort_by=itemName` |
| `order` | `asc` (default) or `desc` | `order=desc` |
| `limit` | Maximum rows to return. Non-negative integer, else `400`. | `limit=50` |
| `offset` | Rows to skip. Non-negative integer, else `400`. May be used without `limit`. | `offset=100` |
| any other name | Equality filter on that column | `active=1`, `itemRarity=Rare` |

`fields`, `sort_by`, `order`, `limit` and `offset` are reserved and never treated as filters.
Filters are equality-only and are combined with AND. Values are bound as strings and
SQLite's column affinity converts them (so `active=1` matches the integer `1`).

The list view can omit the long `itemDescription` text with `fields=` and a by-id request
can fetch it:

```
GET /rest/Item?active=1&fields=itemID,itemName,itemRarity,itemCost&sort_by=itemName&limit=50&offset=100
GET /rest/Item/42?fields=itemID,itemName,itemDescription
```

### Writing

POST, PATCH and PUT take a JSON object whose keys are column names. The body must be valid
JSON, a non-empty object, with valid column names; otherwise the response is `400`.

```bash
curl -X POST 'https://dnd-service.omnomnom.org/rest/Item' \
  --header 'Authorization: Bearer <YOUR-SECRET-VALUE>' \
  --header 'Content-Type: application/json' \
  --data '{"itemID": 2000, "itemName": "Bag of Holding", "itemRarity": "Uncommon", "itemCost": 500}'

curl -X PATCH 'https://dnd-service.omnomnom.org/rest/Item/2000' \
  --header 'Authorization: Bearer <YOUR-SECRET-VALUE>' \
  --header 'Content-Type: application/json' \
  --data '{"itemCost": 750}'
```

Update and delete succeed (`200`) even when no row matches the id.

## Responses

### Success

Reads return D1's raw result object unchanged:

```json
{
    "success": true,
    "meta": { "duration": 0.17, "rows_read": 2, "rows_written": 0 },
    "results": [ { "itemID": 1, "itemName": "Bag of Holding" } ]
}
```

Consumers (such as the Angular app) unwrap `results` from this object. POST returns
`201 {"message": "Resource created successfully", "data": {...}}`, PATCH/PUT returns
`{"message": "Resource updated successfully", "data": {...}}` and DELETE returns
`{"message": "Resource deleted successfully"}`.

### Errors

All errors from `/rest/*` and the auth check use the same shape:

```json
{ "success": false, "error": "Invalid limit. Expected a non-negative integer" }
```

| Status | Meaning |
|--------|---------|
| 400 | Bad input: invalid JSON or body, invalid `fields`, `limit` or `offset`, missing id on update/delete |
| 401 | Missing or wrong token |
| 405 | Method not allowed |
| 500 | Database error (for example unknown table or column, constraint violation) |

The raw `/query` route keeps its original `{"error": "..."}` body (no `success` flag).

## Schema: `Item`

Live DDL (as captured from the production database; see `migrations/0001_baseline.sql`):

| Column | Type | Notes |
|--------|------|-------|
| `itemID` | `int` | Primary key (`PK_tblItem`). Not auto-increment; supplied by the client. |
| `itemName` | `nvarchar(150)` | |
| `itemRarity` | `nvarchar(20)` | `Common`, `Uncommon`, `Rare`, `Very Rare`, `Legendary`, `Artifact`, `Varies`, `Unknown Rarity` |
| `itemCost` | `int` | `0` means there is no fixed price |
| `itemType` | `nvarchar(20)` | |
| `itemRestrictions` | `nvarchar(150)` | |
| `itemAttunement` | `nvarchar(20)` | |
| `itemSource` | `nvarchar(150)` | |
| `itemUrl` | `nvarchar(200)` | |
| `itemVisualDesc` | `nvarchar(1000)` | |
| `itemShopkeeperDesc` | `nvarchar(1000)` | |
| `active` | `INTEGER NOT NULL DEFAULT 1` | `CHECK (active IN (0,1))`. `1` = listed in the marketplace, `0` = hidden/retired. Clients list with `?active=1`. |
| `itemDescription` | `TEXT` | Long description; omit from list views with `fields=` |
| `itemDescriptionSource` | `TEXT` | |

## Migrations

Schema changes are SQL files in `migrations/`, applied in order with Wrangler's D1
migrations (`migrations_dir` is set on the `DB` entry in `wrangler.jsonc`).

```bash
# Create a new migration file (migrations/0002_<name>.sql)
npx wrangler d1 migrations create DB add_something

# See what is pending, and apply, against the LOCAL database
npx wrangler d1 migrations list DB --local
npx wrangler d1 migrations apply DB --local
```

`0001_baseline.sql` describes the schema that already exists in production, using
`CREATE TABLE IF NOT EXISTS Item (...)` with all 14 columns. On the existing database it
is a **no-op** (the table is already there, nothing is changed or dropped); it only
makes Wrangler record the baseline in its `d1_migrations` bookkeeping table. On a fresh
database (local dev, tests) it creates the table. Applying migrations to the remote
database (`--remote`) is a deliberate owner action and is never done by the tests.

Because the baseline keeps the exact live column definitions, do not edit it after it has
been applied anywhere; add a new numbered migration instead.

## Development and tests

```bash
npm install
npm run dev        # wrangler dev
npm test           # vitest run
npx tsc --noEmit   # type check
```

Tests use Vitest with `@cloudflare/vitest-pool-workers`: they run the real Worker code
inside workerd (Miniflare) against a local, in-memory D1 database and a local secrets
store. `test/setup.ts` applies `migrations/` and stores a throwaway test secret, so no network access to
Cloudflare is needed, the real secret is never read, and the remote database is never
touched (remote bindings are disabled in `vitest.config.mts`). Tests cover by-id
GET/PATCH/DELETE on `Item`, filters, `fields`, `limit`/`offset`, invalid JSON, and auth.

Note: `vitest.config.mts` uses the `.mts` extension because the test pool package is
ESM-only and this project is CommonJS by default.

`worker-configuration.d.ts` is generated by `npm run cf-typegen`. It predates the pipeline
binding in `wrangler.jsonc` and was intentionally not regenerated here, because a
regeneration rewrites the whole bundled runtime-types section (thousands of lines).

## Security notes

- Table and column names are sanitized (letters, digits and `_` only) and values are always
  bound as parameters, which protects against SQL injection through the REST routes.
- There is **no table or column allowlist**. Any caller holding the token can read and
  write any table in the database through `/rest/{table}`. This is an open decision for
  the owner.
- `POST /query` executes **arbitrary SQL** with the supplied parameters (including
  `DROP TABLE` and other DDL). A single shared token guards everything, so any token
  holder has full read/write/DDL access to the whole database. It has intentionally not
  been restricted or removed yet; whether to restrict it is an open decision.
- The token is shared by all clients. Keep it out of browser code (the Angular app reaches
  this API through a Pages Function) and rotate it in the Secrets Store if it leaks.
- CORS is open (`*`); access control relies on the token only.
