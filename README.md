# dnd-db-rest

The data API behind Adventurer's Ledger, a D&D magic-item marketplace. It is a small
Cloudflare Worker (Hono) that exposes a token-protected REST API over a Cloudflare D1
(SQLite) database named `dnd-db`. The main table is `Item`, the catalogue of magic items
(about 1,400 rows at the time of writing: 1,393).

- Runtime: Cloudflare Workers, Hono, D1 binding `DB`, Secrets Store binding `SECRET`
- Code: `src/index.ts` (routing, CORS, auth, `/query`), `src/rest.ts` (generic CRUD
  handlers and the table allowlist), `src/sql-guard.ts` (read-only check for `/query`)
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
token (the `Bearer` scheme is case-insensitive) or as the bare value of the
`Authorization` header:

```
Authorization: Bearer <YOUR-SECRET-VALUE>
```

The secret lives in the Cloudflare Secrets Store (`dnd-db-rest-secret`) and is compared in
constant time. The header is checked before the Secrets Store is read, so unauthenticated
requests never cost a Secrets Store call. A missing or wrong token returns `401`; an empty
or missing secret returns `500 Server misconfigured` and can never authenticate.
`GET /` is an open status check.

## REST endpoints

`{table}` is the name of an allowlisted table (see below), matched case-insensitively.
`{id}` is the integer value of the table's primary key. Path segments are URL-decoded
(`/rest/It%65m` is `/rest/Item`); extra or empty segments (`/rest/Item/1/x`, `/rest//Item`)
are `404`, malformed percent-encoding is `400`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/rest/{table}` | List rows, with filters, sorting, pagination, projection |
| GET | `/rest/{table}/{id}` | Get one row by primary key (returns a `results` array with 0 or 1 row) |
| POST | `/rest/{table}` | Insert a row from a JSON object (`201`); the primary key is required |
| PATCH / PUT | `/rest/{table}/{id}` | Update the given columns of a row (both behave the same: a partial update) |
| DELETE | `/rest/{table}/{id}` | Delete a row |
| POST | `/query` | Raw parameterised **read-only** SQL (see below) |

### Table allowlist and primary key

Only tables listed in the `TABLES` object in `src/rest.ts` are reachable. Every other
name (`sqlite_master`, `d1_migrations`, `_cf_*`, a typo, ...) answers `404` for every
method and cannot be read or written. Each entry names the table's primary-key column,
which the by-id routes use:

| Table | Primary key |
|-------|-------------|
| `Item` | `itemID` |

So `GET /rest/Item/42` runs `SELECT * FROM "Item" WHERE "itemID" = ? LIMIT ?`. To expose a
new table, add it to `TABLES` with its primary-key column. Table names must match
`^[A-Za-z_][A-Za-z0-9_]*$`.

Primary keys are integers. A path id (and an `itemID=` filter value) must match
`^-?\d+$`, so `/rest/Item/1.0` and `/rest/Item/1e0` are `400` rather than matching item 1.
`itemID` is declared `int ... primary key`, which in SQLite is **not** an auto-incrementing
rowid alias and does allow `NULL`. Clients must therefore supply an integer `itemID` on
POST (a missing or null key is `400`), and PATCH/PUT refuses to set it to null or to a
non-integer. Migration `0002_item_id_guard.sql` adds database triggers that enforce the
same rule for any other writer.

### Query parameters (GET)

| Parameter | Description | Example |
|-----------|-------------|---------|
| `fields` | Comma-separated columns to return instead of `*`. Works on list and by-id. An empty or invalid list returns `400`. | `fields=itemID,itemName` |
| `sort_by` | Column to sort by | `sort_by=itemName` |
| `order` | `asc` (default) or `desc` | `order=desc` |
| `limit` | Maximum rows to return. Non-negative integer, at most `5000` (above that is `400`). Default `2000`. An empty value (`limit=`) means "not given". | `limit=50` |
| `offset` | Rows to skip. Non-negative integer, else `400`. May be used without `limit`. | `offset=100` |
| any other name | Equality filter on that column | `active=1`, `itemRarity=Rare` |

`fields`, `sort_by`, `order`, `limit` and `offset` are reserved and never treated as
filters; they are matched case-insensitively (`?Limit=1` works), and sending the same
reserved name twice is `400`. Filters are equality-only and are combined with AND. Values
are bound as strings and SQLite's column affinity converts them (so `active=1` matches the
integer `1`).

Column names (in `fields`, `sort_by`, filters and write bodies) are matched exactly,
case-sensitively, against the table's real columns (`PRAGMA table_info`, cached per
Worker isolate and re-read once when a name is not found, so a column added by a
migration is picked up). A name with anything other than letters, digits and `_` is `400
Invalid parameter name` / `Invalid column name` (it is never rewritten into another
name), and an unknown column is `400 Unknown column: x`. Identifiers are double-quoted in
the generated SQL, so keyword-named columns work.

Limits: the catalogue is about 1.4k rows and the default `limit` is 2000, so an
unparameterised `GET /rest/Item` still returns everything. The maximum of 5000 is a safety
net, not something clients are expected to reach.

The list view can omit the long `itemDescription` text with `fields=` and a by-id request
can fetch it:

```
GET /rest/Item?active=1&fields=itemID,itemName,itemRarity,itemCost&sort_by=itemName&limit=50&offset=100
GET /rest/Item/42?fields=itemID,itemName,itemDescription
```

### Writing

POST, PATCH and PUT take a JSON object whose keys are column names. The body must be valid
JSON and a non-empty object. Values may only be strings, finite numbers, booleans (stored
as 1/0) or `null`; arrays, objects and non-finite numbers are `400` naming the offending
column. Columns with integer affinity (`itemID`, `itemCost`, `active`) take whole numbers
(or numeric text such as `"5"`); `{"itemCost": "abc"}` is `400`.

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

PATCH, PUT and DELETE on an id that does not exist return `404 Not found` (and change
nothing).

### Raw query: `POST /query` (read-only)

```bash
curl -X POST 'https://dnd-service.omnomnom.org/query' \
  --header 'Authorization: Bearer <YOUR-SECRET-VALUE>' \
  --header 'Content-Type: application/json' \
  --data '{"query": "SELECT itemID, itemName FROM Item WHERE active = ? LIMIT 5", "params": [1]}'
```

`/query` only runs a **single SELECT or WITH (read-only CTE) statement**; `params` (an array
of strings, numbers, booleans or null) are bound as before and allowed queries return D1's
raw result object. Anything else is refused with `403
{"success": false, "error": "Only read-only queries are allowed"}` before it reaches the
database:

- statements that do not start with `SELECT` or `WITH` (INSERT, UPDATE, DELETE, REPLACE,
  DROP, ALTER, CREATE, PRAGMA, ATTACH, VACUUM, EXPLAIN, ...), also after leading comments
  or whitespace and in any letter case;
- more than one statement (a `;` followed by anything but whitespace and comments);
- those write/DDL/PRAGMA keywords anywhere in the statement outside string literals,
  quoted identifiers and comments (so `WITH x AS (...) DELETE ...` is refused, while
  `replace(x, 'a', 'b')` and `'DROP TABLE'` inside a string are fine);
- any reference to a name starting with `sqlite_`, `d1_` or `_cf_`, or to `pragma_*`
  functions.

The check is deliberately conservative (it can refuse an odd but harmless query). **Data
changes and schema changes (DDL) must go through `wrangler d1 execute`, not through the
API.** An SQL mistake in an allowed query is `400 Query could not be executed`; the database
message is logged server-side only.

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

Every error uses the same shape, including unknown routes and unexpected failures:

```json
{ "success": false, "error": "Invalid limit. Expected a non-negative integer" }
```

| Status | Meaning |
|--------|---------|
| 400 | Bad input: invalid JSON, body, name, value, id, `fields`, `limit` or `offset`; unknown column; missing id on update/delete; missing primary key on POST |
| 401 | Missing or wrong token |
| 403 | `/query` statement is not read-only |
| 404 | Unknown route, unknown or non-allowlisted table, extra path segments, or no row with that id (PATCH/PUT/DELETE) |
| 405 | Method not allowed on `/rest/*` |
| 409 | Duplicate primary key (or other UNIQUE constraint) |
| 422 | A table constraint failed (for example `active` must be 0 or 1, or a NOT NULL column was set to null) |
| 500 | Unexpected error (generic message; the detail is logged with `console.error`, never returned), or `Server misconfigured` when the secret is empty |

## Schema: `Item`

Live DDL (as captured from the production database; see `migrations/0001_baseline.sql`):

| Column | Type | Notes |
|--------|------|-------|
| `itemID` | `int` | Primary key (`PK_tblItem`). Not auto-increment; supplied by the client. Never NULL (see `0002`). |
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
# Create a new migration file (migrations/0003_<name>.sql)
npx wrangler d1 migrations create DB add_something

# See what is pending, and apply, against the LOCAL database
npx wrangler d1 migrations list DB --local
npx wrangler d1 migrations apply dnd-db --local
```

- `0001_baseline.sql` describes the schema that already exists in production, using
  `CREATE TABLE IF NOT EXISTS Item (...)` with all 14 columns. On the existing database it
  is a **no-op** (the table is already there, nothing is changed or dropped); it only
  makes Wrangler record the baseline in its `d1_migrations` bookkeeping table. On a fresh
  database (local dev, tests) it creates the table.
- `0002_item_id_guard.sql` creates two triggers (`CREATE TRIGGER IF NOT EXISTS`, so it is
  idempotent) that abort any INSERT or `UPDATE OF itemID` that would leave `itemID` NULL.
  It does not look at existing rows; before applying it to a database that may contain
  orphans run `SELECT COUNT(*) FROM Item WHERE itemID IS NULL`.

- `0003_game_data_tables.sql` creates the game-data tables designed in Zr0AM/dnd-app
  (`docs/db/schema-plan.md`). There are 75 new tables in these groups:
  - reference: abilities, skills, damage types, conditions, rarity, coins, challenge ratings and so on
  - equipment
  - classes
  - spells
  - species, backgrounds and feats
  - monsters
  - rules
  - the treasure generator's config

  It also creates 3 read views (`SpellListView`, `MonsterListView`, `EquipmentListView`)
  and adds 8 nullable columns to `Item`: `itemSlug`, `rarityID`, `categoryID`,
  `sourceID`, `sourcePage`, `itemRequiresAttunement`, `itemHeader` and
  `itemBaseRequirement`. Existing `Item` rows are not changed. The new tables are
  **not** added to the REST allowlist (`TABLES`), so the API serves exactly what it
  served before.

Applying migrations to the remote database (`--remote`) is a deliberate owner action and is
never done by the tests.

## SRD seed data (`seed/srd/`)

The rows for the 0003 tables are in `seed/srd/`, from the System Reference Document
5.2.1 (the 2024 rules). They are kept apart from the migrations so they can be
re-applied when the data is regenerated. They are generated by
`scripts/srd/build-srd-seed.mjs` in Zr0AM/dnd-app; do not edit them by hand.

| File | Rows |
|------|------|
| `01-reference.sql` | Source, abilities, skills, damage types, conditions, sizes, creature types, alignments, languages, coins, rarity, item categories, schools, CR and level tables, weapon properties and masteries, poisons |
| `02-equipment.sql` | 182 items: weapons, armor, tools, gear, packs |
| `03-classes.sql` | 12 classes with their level tables, spell slots, 12 subclasses and 232 features |
| `04-spells.sql` | 339 spells and class spell lists |
| `05-origins.sql` | 17 feats, 9 species with lineage options, 4 backgrounds |
| `06-monsters.sql` | 341 monsters with their full stat blocks |
| `07-items-backfill.sql` | Fills the new `Item` columns (and `ItemVariant`, `ItemAttunementReq`) on existing rows whose `itemName` matches an SRD magic item. Inserts no `Item` rows and changes no existing column. |

Every file is idempotent. Rows are upserted on their slug or natural key, and child
rows are replaced, so running the files twice leaves the same data. Apply them in
order, after the migration:

```bash
# Local first
npx wrangler d1 migrations apply dnd-db --local
for f in seed/srd/*.sql; do npx wrangler d1 execute dnd-db --local --file "$f"; done

# Then the real database (owner action). Note a restore point first with
# `npx wrangler d1 time-travel info dnd-db`.
npx wrangler d1 migrations apply dnd-db --remote
for f in seed/srd/*.sql; do npx wrangler d1 execute dnd-db --remote --file "$f"; done
```

The data is CC-BY-4.0. Each file starts with the attribution the license requires. Do not edit a migration after it has been applied anywhere; add a
new numbered migration instead.

## Development and tests

```bash
npm install
npx tsc --noEmit   # type check
npm test           # vitest run
```

### Running the Worker locally (`wrangler dev`)

`wrangler dev` uses a local D1 database and a local Secrets Store (both empty at first), so
two one-time steps are needed:

```bash
# 1. Create the tables in the local database
npx wrangler d1 migrations apply dnd-db --local

# 2. Put a throwaway value in the LOCAL secrets store (local is the default; add
#    --remote only if you really mean the real store, which you should not)
npx wrangler secrets-store secret create 054dccb20f304a36b0f041e9e560c5aa \
  --name dnd-db-rest-secret --scopes workers
#   (prompts for the value; use any made-up string, it is only for local dev)

npm run dev
curl -H 'Authorization: Bearer <the-value-you-just-entered>' http://localhost:8787/rest/Item
```

Windows gotcha: the local state lives under `.wrangler/state` inside the project. When the
project path is long (for example a deep worktree folder) the local D1 / Secrets Store
commands can fail with `internal error` or `Network connection lost`. Point every local
command at a short directory with `--persist-to`, e.g. `--persist-to C:/wrs`, and start the
server with the same flag (`npx wrangler dev --persist-to C:/wrs`).

### Test suite

Tests use Vitest with `@cloudflare/vitest-pool-workers`: they run the real Worker code
inside workerd (Miniflare) against a local, in-memory D1 database and a local secrets
store. `test/setup.ts` applies every file in `migrations/` and stores a throwaway test
secret, so no network access to Cloudflare is needed, the real secret is never read, and
the remote database is never touched (remote bindings are disabled in
`vitest.config.mts`). The suite covers by-id GET/PATCH/DELETE on `Item`, filters, `fields`,
`limit`/`offset`, body and name validation, injection attempts, the table allowlist, the
migration triggers, the read-only `/query` guard, and authentication.
`test/srd-seed.test.ts` applies `seed/srd/*.sql` on top of the migrations. It then
checks:

- the row counts
- `PRAGMA foreign_key_check`
- that a second run changes nothing
- the `Item` backfill
- the read views

Note: `vitest.config.mts` uses the `.mts` extension because the test pool package is
ESM-only and this project is CommonJS by default.

`worker-configuration.d.ts` is generated by `npm run cf-typegen`. It predates the pipeline
binding in `wrangler.jsonc` and was intentionally not regenerated here, because a
regeneration rewrites the whole bundled runtime-types section (thousands of lines).

### Dependencies

Only `hono` (and `src/`) is bundled into the deployed Worker; wrangler, vitest and the
test pool are development tooling. `package.json` has an `overrides` entry for
`@cloudflare/vitest-pool-workers`: version 0.22.0 pins an exact `wrangler` and `miniflare`
(which bring vulnerable `undici` and `sharp`), so they are forced to the top-level
`wrangler` and the matching patched `miniflare` until the pool publishes a release that does
it itself. Remove the override then. The lockfile is generated with npm 10 (the version in
Cloudflare's build image); keep `npm ci` working under it.

`wrangler.jsonc` sets `observability.redact_query_string` to `false`: supported by the
current wrangler schema (the older 4.124 wrangler warned about it as unexpected). It means
query strings, which carry the filter values, are kept in logs and traces.

## Security notes

- Table and column names are validated (letters, digits and `_` only, and they must be a
  real column of an allowlisted table), identifiers are double-quoted and values are always
  bound as parameters, which protects against SQL injection through the REST routes.
- Only tables in `TABLES` can be reached through `/rest`. Adding a table to it is a
  decision to expose all of its rows and columns to every token holder.
- `POST /query` is read-only (see above) and cannot see `sqlite_*`, `d1_*` or `_cf_*`
  tables, but it can still read every other table. Writes and DDL go through
  `wrangler d1 execute`.
- Unexpected database errors are logged (`console.error`) and returned as a generic 500;
  raw SQLite text is never sent to the client.
- The token is shared by all clients. Keep it out of browser code (the Angular app reaches
  this API through a Pages Function) and rotate it in the Secrets Store if it leaks.
- CORS is open (`*`); access control relies on the token only.
