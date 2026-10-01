import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isReadOnlyQuery } from "../src/sql-guard";
import { AUTH, call, expectError, itemCount, itemRow, seed, send } from "./helpers";

const query = (body: unknown) => send("POST", "/query", body);

/** Bindings whose DB records every SQL string that gets prepared. */
function spyBindings(sqls: string[]) {
	const db = new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) => {
					sqls.push(sql);
					return target.prepare(sql);
				};
			}
			const value = (target as any)[prop];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { DB: db, SECRET: env.SECRET };
}

beforeEach(seed);
afterEach(() => vi.restoreAllMocks());

const ALLOWED: [string, string][] = [
	["plain select", "SELECT itemID, itemName FROM Item"],
	["lower case", "select itemid from item"],
	["mixed case", "SeLeCt itemID FrOm Item"],
	["leading whitespace and newlines", "\n\t  SELECT itemID FROM Item"],
	["trailing semicolon", "SELECT itemID FROM Item;"],
	["trailing semicolon and whitespace", "SELECT itemID FROM Item ;  \n "],
	["leading block comment", "/* just a comment */ SELECT itemID FROM Item"],
	["leading line comment", "-- note\nSELECT itemID FROM Item"],
	["trailing comment", "SELECT itemID FROM Item -- DELETE FROM Item"],
	["semicolon and keywords inside a comment", "SELECT 1 /* ; DROP TABLE Item; DELETE FROM Item */"],
	["semicolon inside a string", "SELECT 'a;b' AS v"],
	["write keywords inside a string", "SELECT 'DROP TABLE Item; DELETE FROM Item; PRAGMA x' AS v"],
	["escaped quote inside a string", "SELECT 'it''s; DROP TABLE Item' AS v"],
	["write keywords as quoted identifiers", 'SELECT 1 AS "delete", 2 AS "insert", 3 AS [update], 4 AS `drop`'],
	["words that merely contain a keyword", "SELECT itemName AS updated, itemName AS created_at, itemName AS dropdown, itemName AS update_count FROM Item"],
	["the replace() function", "SELECT replace(itemName, 'a', 'b') FROM Item"],
	["WITH (CTE)", "WITH x AS (SELECT itemID FROM Item) SELECT * FROM x"],
	["lower case WITH", "with x as (select itemID from Item) select * from x"],
	["recursive CTE", "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT i FROM n"],
	["subquery", "SELECT itemName FROM Item WHERE itemID IN (SELECT itemID FROM Item WHERE active = 1)"],
	["aggregate", "SELECT COUNT(*) AS n FROM Item"],
	["an alias that looks like a keyword prefix", "SELECT itemName AS Replaced FROM Item"],
	// Tokenizer parity: SQLite has no backslash escapes, and a `/*/` does not close its own comment
	["a lone backslash in a string (SQLite has no backslash escapes)", "SELECT '\\' AS v"],
	["a lone backslash in a double-quoted identifier", 'SELECT 1 AS "\\"'],
	["a lone backslash in a backtick identifier", "SELECT 1 AS `\\`"],
	["a lone backslash in a bracket identifier", "SELECT 1 AS [\\]"],
	["a comment opener that cannot close itself", "SELECT 1 AS v /*/ DELETE FROM Item"],
	["comment markers inside strings", "SELECT '/*' AS a, '*/' AS b, '--' AS c"],
];

const REJECTED: [string, string][] = [
	["INSERT", "INSERT INTO Item (itemID, itemName) VALUES (900, 'x')"],
	["UPDATE", "UPDATE Item SET itemCost = 1"],
	["DELETE", "DELETE FROM Item"],
	["DROP", "DROP TABLE Item"],
	["ALTER", "ALTER TABLE Item ADD COLUMN x TEXT"],
	["CREATE TABLE", "CREATE TABLE Evil (x TEXT)"],
	["CREATE TRIGGER", "CREATE TRIGGER evil AFTER INSERT ON Item BEGIN SELECT 1; END"],
	["REPLACE", "REPLACE INTO Item (itemID, itemName) VALUES (1, 'x')"],
	["INSERT OR REPLACE", "INSERT OR REPLACE INTO Item (itemID, itemName) VALUES (1, 'x')"],
	["PRAGMA", "PRAGMA table_info(Item)"],
	["PRAGMA writable_schema", "PRAGMA writable_schema = 1"],
	["ATTACH", "ATTACH DATABASE ':memory:' AS x"],
	["DETACH", "DETACH DATABASE x"],
	["VACUUM", "VACUUM"],
	["REINDEX", "REINDEX"],
	["ANALYZE", "ANALYZE"],
	["EXPLAIN", "EXPLAIN SELECT 1"],
	["BEGIN", "BEGIN"],
	["VALUES", "VALUES (1)"],
	["lower case delete", "delete from Item"],
	["mixed case delete", "DeLeTe FrOm Item"],
	["lower case drop", "drop table item"],
	["block comment before DELETE", "/* x */ DELETE FROM Item"],
	["line comment before DELETE", "-- x\nDELETE FROM Item"],
	["several comments before DELETE", "/* a */ /* b */ -- c\n DELETE FROM Item"],
	["comment between DELETE and FROM", "DELETE/**/FROM Item"],
	["a statement starting with a parenthesis", "(SELECT 1)"],
	["empty statement then select", ";SELECT 1"],
	["only a comment", "/* SELECT 1 */"],
	["SELECT then DROP", "SELECT 1; DROP TABLE Item"],
	["SELECT then DELETE without space", "SELECT 1;DELETE FROM Item"],
	["SELECT then DELETE after a comment", "SELECT 1; /* c */ DELETE FROM Item"],
	["SELECT then DELETE after a line comment and newline", "SELECT 1 -- c\n; DELETE FROM Item"],
	["two selects", "SELECT 1; SELECT 2"],
	["double semicolon", "SELECT 1;;"],
	["semicolon then comment then select", "SELECT 1; -- c\nSELECT 2"],
	["WITH ... DELETE", "WITH x AS (SELECT 1) DELETE FROM Item"],
	["WITH ... INSERT", "WITH x AS (SELECT 1 AS a) INSERT INTO Item (itemID, itemName) SELECT a, 'x' FROM x"],
	["WITH ... UPDATE", "WITH x AS (SELECT 1) UPDATE Item SET itemCost = 1"],
	["WITH ... REPLACE INTO", "WITH x AS (SELECT 1 AS a) REPLACE INTO Item (itemID) SELECT a FROM x"],
	["lower case WITH ... delete", "with x as (select 1) delete from Item"],
	["a write keyword in a CTE body", "WITH x AS (DELETE FROM Item) SELECT 1"],
	["a DROP after a real statement end", "SELECT 1 FROM Item; drop table Item"],
	["select from sqlite_master", "SELECT * FROM sqlite_master"],
	["lower case sqlite_master", "select name from sqlite_master"],
	["upper case SQLITE_MASTER", "SELECT name FROM SQLITE_MASTER"],
	["sqlite_schema", "SELECT * FROM sqlite_schema"],
	["schema-qualified sqlite_master", "SELECT * FROM main.sqlite_master"],
	["sqlite_sequence", "SELECT * FROM sqlite_sequence"],
	["sqlite_stat1", "SELECT * FROM sqlite_stat1"],
	["double-quoted sqlite_master", 'SELECT * FROM "sqlite_master"'],
	["bracketed sqlite_master", "SELECT * FROM [sqlite_master]"],
	["backticked sqlite_master", "SELECT * FROM `sqlite_master`"],
	["string-literal sqlite_master (SQLite accepts it as a table name)", "SELECT * FROM 'sqlite_master'"],
	["sqlite_master in a subquery", "SELECT itemName FROM Item WHERE itemID IN (SELECT rootpage FROM sqlite_master)"],
	["sqlite_master in a CTE", "WITH x AS (SELECT * FROM sqlite_master) SELECT * FROM x"],
	["sqlite_master in a join", "SELECT * FROM Item JOIN sqlite_master ON 1"],
	["d1_migrations", "SELECT * FROM d1_migrations"],
	["D1_MIGRATIONS", "SELECT * FROM D1_MIGRATIONS"],
	["_cf_KV", "SELECT * FROM _cf_KV"],
	["_cf_METADATA", "SELECT * FROM _cf_METADATA"],
	["pragma table-valued function", "SELECT * FROM pragma_table_info('Item')"],
	["pragma function without arguments", "SELECT name FROM pragma_database_list"],
	// Tokenizer parity: each of these is a REAL write in SQLite (checked with SQLite's authorizer). A scanner
	// that treated a backslash as an escape, or mis-read one quote style inside another, would hide the write.
	["backslash in a single-quoted string hides a DELETE", "WITH x AS (SELECT '\\') DELETE FROM Item WHERE '\\' = '\\'"],
	["backslash in a double-quoted identifier hides a DELETE", 'WITH x AS (SELECT 1 AS "\\") DELETE FROM Item WHERE itemID IN (SELECT "\\" FROM x)'],
	["backslash in a backtick identifier hides a DELETE", "WITH x AS (SELECT 1 AS `\\`) DELETE FROM Item WHERE itemID IN (SELECT `\\` FROM x)"],
	["backslash in a bracket identifier hides a DELETE", "WITH x AS (SELECT 1 AS [\\]) DELETE FROM Item WHERE itemID IN (SELECT [\\] FROM x)"],
	["backslash string followed by a second statement", "SELECT '\\'; DELETE FROM Item; --'"],
	["backslash string followed by an UPDATE", "WITH x AS (SELECT '\\') UPDATE Item SET itemCost = 1 WHERE '\\' = '\\'"],
	["backslash string followed by an INSERT", "WITH x AS (SELECT '\\') INSERT INTO Item (itemID, itemName) SELECT 900, '\\' FROM x"],
	["backslash string followed by a DROP", "SELECT '\\'; DROP TABLE Item; --'"],
	["single quote inside a double-quoted alias", "WITH x AS (SELECT 1 AS \"'\") DELETE FROM Item WHERE itemID IN (SELECT \"'\" FROM x)"],
	["single quote inside a backtick alias", "WITH x AS (SELECT 1 AS `'`) DELETE FROM Item WHERE itemID IN (SELECT `'` FROM x)"],
	["single quote inside a bracket alias", "WITH x AS (SELECT 1 AS [']) DELETE FROM Item WHERE itemID IN (SELECT ['] FROM x)"],
	["double quote inside a single-quoted string", "WITH x AS (SELECT '\"') DELETE FROM Item WHERE '\"' = '\"'"],
	["backtick inside a single-quoted string", "WITH x AS (SELECT '`') DELETE FROM Item WHERE '`' = '`'"],
	["bracket inside a single-quoted string", "WITH x AS (SELECT '[') DELETE FROM Item WHERE '[' = '['"],
	["closing bracket inside a double-quoted alias", 'WITH x AS (SELECT 1 AS "]") DELETE FROM Item WHERE itemID IN (SELECT "]" FROM x)'],
	["doubled single quotes inside a string", "WITH x AS (SELECT 'it''s') DELETE FROM Item WHERE 'it''s' = 'it''s'"],
	["doubled double quotes inside an identifier", 'WITH x AS (SELECT 1 AS "a""b") DELETE FROM Item WHERE itemID IN (SELECT "a""b" FROM x)'],
	["comment marker inside a quoted alias", 'WITH x AS (SELECT 1 AS "--") DELETE FROM Item WHERE itemID IN (SELECT "--" FROM x)'],
	["block-comment opener inside a quoted alias", 'WITH x AS (SELECT 1 AS "/*") DELETE FROM Item WHERE itemID IN (SELECT "/*" FROM x) /* */'],
	["semicolon inside a quoted alias before a real second statement", 'SELECT 1 AS ";"; DELETE FROM Item'],
	["quote inside a line comment before a DELETE", "WITH x AS (SELECT 1) -- '\nDELETE FROM Item"],
	["quote inside a block comment before a DELETE", "WITH x AS (SELECT 1) /* ' */ DELETE FROM Item /* ' */"],
	["form feed between WITH and DELETE", "WITH x AS (SELECT 1)\fDELETE FROM Item"],
];

// Each forbidden keyword on its own, hidden behind a WITH prefix (so only the keyword scan
// can catch it, not the first-keyword rule)
for (const keyword of ["INSERT INTO Item (itemID) VALUES (1)", "UPDATE Item SET itemCost = 1", "DELETE FROM Item", "REPLACE INTO Item (itemID) VALUES (1)",
	"DROP TABLE Item", "ALTER TABLE Item ADD COLUMN x TEXT", "CREATE TABLE Evil (x TEXT)", "ATTACH DATABASE ':memory:' AS x", "DETACH DATABASE x",
	"PRAGMA table_info(Item)", "VACUUM", "REINDEX", "ANALYZE"]) {
	REJECTED.push([`WITH prefix hiding ${keyword.split(" ")[0]}`, `WITH x AS (SELECT 1) ${keyword}`]);
	REJECTED.push([`lower-case WITH prefix hiding ${keyword.split(" ")[0]}`, `with x as (select 1) ${keyword.toLowerCase()}`]);
}

describe("POST /query (read-only)", () => {
	it.each(ALLOWED)("allows %s", async (_name, sql) => {
		const res = await query({ query: sql });
		const body: any = await res.json();
		expect(res.status, JSON.stringify(body)).toBe(200);
		expect(body.success).toBe(true);
		expect(Array.isArray(body.results)).toBe(true);
		expect(body.meta).toBeDefined();
		// An approved statement must really be a read: nothing in the table may have changed
		expect(await itemCount()).toBe(4);
		expect((await itemRow(1))!.itemName).toBe("Bag of Holding");
	});

	it("returns D1's raw result shape", async () => {
		const res = await query({ query: "SELECT itemID, itemName FROM Item ORDER BY itemID LIMIT 2" });
		const body: any = await res.json();
		expect(res.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.results).toEqual([{ itemID: 1, itemName: "Bag of Holding" }, { itemID: 2, itemName: "Vorpal Sword" }]);
	});

	it("binds params", async () => {
		const res = await query({ query: "SELECT itemID FROM Item WHERE active = ? AND itemCost > ? ORDER BY itemID", params: [1, 100] });
		expect(((await res.json()) as any).results).toEqual([{ itemID: 1 }, { itemID: 4 }]);
	});

	it("binds text, null and boolean params", async () => {
		expect(((await (await query({ query: "SELECT itemID FROM Item WHERE itemName = ?", params: ["Cloak"] })).json()) as any).results).toEqual([{ itemID: 4 }]);
		expect(((await (await query({ query: "SELECT ? IS NULL AS n", params: [null] })).json()) as any).results).toEqual([{ n: 1 }]);
		expect(((await (await query({ query: "SELECT itemID FROM Item WHERE active = ? ORDER BY itemID", params: [false] })).json()) as any).results).toEqual([{ itemID: 3 }]);
	});

	it("treats SQL inside a param as data", async () => {
		const res = await query({ query: "SELECT itemID FROM Item WHERE itemName = ?", params: ["x'; DROP TABLE Item; --"] });
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).results).toEqual([]);
		expect(await itemCount()).toBe(4);
	});

	it.each(REJECTED)("rejects %s with 403 and never prepares it", async (_name, sql) => {
		const sqls: string[] = [];
		const res = await call(
			"/query",
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) },
			AUTH,
			spyBindings(sqls)
		);
		expect(await expectError(res, 403, "Only read-only queries are allowed")).toEqual({
			success: false,
			error: "Only read-only queries are allowed",
		});
		expect(sqls).toEqual([]);
	});

	it("leaves the database untouched after the rejected statements", async () => {
		for (const [, sql] of REJECTED) await query({ query: sql });
		expect(await itemCount()).toBe(4);
		expect((await itemRow(1))!.itemName).toBe("Bag of Holding");
		expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name IN ('Evil', 'evil')").first()).toBeNull();
		expect(((await env.DB.prepare("PRAGMA table_info(Item)").all()).results as any[]).map((c) => c.name)).not.toContain("x");
	});

	it("rejects params that are not an array of scalars", async () => {
		const msg = "params must be an array of strings, numbers, booleans or null";
		await expectError(await query({ query: "SELECT 1", params: "x" }), 400, msg);
		await expectError(await query({ query: "SELECT 1", params: { a: 1 } }), 400, msg);
		await expectError(await query({ query: "SELECT ?", params: [{ a: 1 }] }), 400, msg);
		await expectError(await query({ query: "SELECT ?", params: [[1]] }), 400, msg);
	});

	it("requires a query string", async () => {
		await expectError(await query({}), 400, "Query is required");
		await expectError(await query({ query: "" }), 400, "Query is required");
		await expectError(await query({ query: "   " }), 400, "Query is required");
		await expectError(await query({ query: 1 }), 400, "Query is required");
		await expectError(await query({ query: ["SELECT 1"] }), 400, "Query is required");
		await expectError(await query({ query: { sql: "SELECT 1" } }), 400, "Query is required");
		await expectError(await query("null"), 400, "Query is required");
	});

	it("rejects invalid JSON", async () => {
		await expectError(await query("{not json"), 400, "Invalid JSON body");
	});

	it("reports SQL mistakes as 400 without echoing database text", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const missing = await expectError(await query({ query: "SELECT * FROM nope_table" }), 400, "Query could not be executed");
		expect(JSON.stringify(missing)).not.toMatch(/nope_table|SQLITE|no such/i);
		await expectError(await query({ query: "SELECT FROM WHERE" }), 400, "Query could not be executed");
		await expectError(await query({ query: "SELECT ?", params: [] }), 400, "Query could not be executed");
		expect(logged).toHaveBeenCalledTimes(3);
		expect(String(logged.mock.calls[0])).toMatch(/nope_table/);
	});

	it("only accepts POST and needs the token", async () => {
		await expectError(await call("/query"), 404, "Not found");
		expect((await call("/query", { method: "POST", body: '{"query":"SELECT 1"}' }, {})).status).toBe(401);
	});
});

describe("isReadOnlyQuery", () => {
	it.each(ALLOWED)("accepts %s", (_name, sql) => expect(isReadOnlyQuery(sql)).toBe(true));
	it.each(REJECTED)("rejects %s", (_name, sql) => expect(isReadOnlyQuery(sql)).toBe(false));

	it("treats an unterminated string or comment as part of the statement", () => {
		expect(isReadOnlyQuery("SELECT 'a; DROP TABLE Item")).toBe(true); // SQLite rejects it as a syntax error
		expect(isReadOnlyQuery("SELECT 1 /* ; DROP TABLE Item")).toBe(true); // everything after /* is a comment
		expect(isReadOnlyQuery("/* unterminated DELETE FROM Item")).toBe(false); // nothing left to run
		expect(isReadOnlyQuery("SELECT 1 -- ; DROP TABLE Item")).toBe(true);
	});
});
