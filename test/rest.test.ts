import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TABLES, handleRest } from "../src/rest";
import { AUTH, call, expectError, itemCount, itemRow, seed, send } from "./helpers";

const ITEM_COLUMNS = [
	"itemID", "itemName", "itemRarity", "itemCost", "itemType", "itemRestrictions",
	"itemAttunement", "itemSource", "itemUrl", "itemVisualDesc", "itemShopkeeperDesc",
	"active", "itemDescription", "itemDescriptionSource",
	// added by 0003_game_data_tables.sql
	"itemSlug", "rarityID", "categoryID", "sourceID", "sourcePage", "itemRequiresAttunement",
	"itemHeader", "itemBaseRequirement",
];

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

/** Bindings whose DB fails every statement except PRAGMA table_info, like an unexpected D1 error. */
function failingBindings(message: string) {
	const db = new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) => {
					if (/^PRAGMA/i.test(sql)) return target.prepare(sql);
					throw new Error(message);
				};
			}
			const value = (target as any)[prop];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { DB: db, SECRET: env.SECRET };
}

beforeEach(seed);

describe("migrations", () => {
	it("creates the Item table with its 14 columns plus the 8 from 0003", async () => {
		const { results } = await env.DB.prepare("PRAGMA table_info(Item)").all<{ name: string }>();
		expect(results.map((r) => r.name)).toEqual(ITEM_COLUMNS);
	});
});

describe("GET /rest/Item", () => {
	it("keeps the D1 response shape on success", async () => {
		const body: any = await (await call("/rest/Item")).json();
		expect(body.success).toBe(true);
		expect(body.results).toHaveLength(4);
		expect(body.meta).toBeDefined();
	});

	it("filters with active=1", async () => {
		const body: any = await (await call("/rest/Item?active=1")).json();
		expect(body.results.map((r: any) => r.itemID).sort()).toEqual([1, 2, 4]);
	});

	it("filters on several columns (AND) and on a text column", async () => {
		const body: any = await (await call("/rest/Item?active=1&itemRarity=Rare")).json();
		expect(body.results.map((r: any) => r.itemID)).toEqual([4]);
	});

	it("gets one item by itemID", async () => {
		const body: any = await (await call("/rest/Item/2")).json();
		expect(body.results).toHaveLength(1);
		expect(body.results[0].itemName).toBe("Vorpal Sword");
		expect(body.results[0].itemDescription).toBe("A very long description 2");
	});

	it("resolves the table case-insensitively", async () => {
		const body: any = await (await call("/rest/item/2")).json();
		expect(body.results[0].itemID).toBe(2);
		expect(((await (await call("/rest/ITEM")).json()) as any).results).toHaveLength(4);
	});

	it("returns an empty result for an unknown id", async () => {
		const res = await call("/rest/Item/999");
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).results).toEqual([]);
	});

	it("combines the path id with a filter", async () => {
		expect(((await (await call("/rest/Item/1?active=0")).json()) as any).results).toEqual([]);
		expect(((await (await call("/rest/Item/3?active=0")).json()) as any).results).toHaveLength(1);
	});

	it("sorts and paginates", async () => {
		const body: any = await (await call("/rest/Item?sort_by=itemID&order=desc&limit=2&offset=1")).json();
		expect(body.results.map((r: any) => r.itemID)).toEqual([3, 2]);
	});

	it("sorts ascending by default and for an unknown order value", async () => {
		const asc: any = await (await call("/rest/Item?sort_by=itemName")).json();
		expect(asc.results.map((r: any) => r.itemName)).toEqual(["Bag of Holding", "Cloak", "Retired Item", "Vorpal Sword"]);
		const odd: any = await (await call("/rest/Item?sort_by=itemName&order=sideways")).json();
		expect(odd.results.map((r: any) => r.itemID)).toEqual([1, 4, 3, 2]);
		const desc: any = await (await call("/rest/Item?sort_by=itemName&order=DESC")).json();
		expect(desc.results.map((r: any) => r.itemID)).toEqual([2, 3, 4, 1]);
	});

	it("ignores an empty sort_by", async () => {
		expect((await call("/rest/Item?sort_by=")).status).toBe(200);
	});

	it("binds filter values, so SQL in a value is just text", async () => {
		for (const value of ["' OR 1=1--", `x"; DROP TABLE Item;--`, "`x`", "1 OR 1=1", "%", "é"]) {
			const res = await call(`/rest/Item?itemName=${encodeURIComponent(value)}`);
			expect(res.status).toBe(200);
			expect(((await res.json()) as any).results).toEqual([]);
		}
		expect(await itemCount()).toBe(4);
	});

	it("uses quoted identifiers in the generated SQL", async () => {
		const sqls: string[] = [];
		await call("/rest/Item?active=1&fields=itemID,itemName&sort_by=itemCost&limit=5&offset=2", {}, AUTH, spyBindings(sqls));
		expect(sqls).toContain(
			'SELECT "itemID", "itemName" FROM "Item" WHERE "active" = ? ORDER BY "itemCost" ASC LIMIT ? OFFSET ?'
		);
	});
});

describe("default limit and maximum limit", () => {
	beforeEach(async () => {
		// 4 seeded rows + 2001 more = 2005 rows
		await env.DB.prepare(
			"WITH RECURSIVE n(i) AS (SELECT 1000 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) " +
				"INSERT INTO Item (itemID, itemName) SELECT i, 'bulk' FROM n"
		).run();
	});

	it("returns at most 2000 rows when no limit is given", async () => {
		const body: any = await (await call("/rest/Item?fields=itemID")).json();
		expect(body.results).toHaveLength(2000);
	});

	it("returns everything up to the maximum when asked for 5000", async () => {
		const body: any = await (await call("/rest/Item?fields=itemID&limit=5000")).json();
		expect(body.results).toHaveLength(2005);
	});

	it("rejects a limit above 5000 with 400", async () => {
		await expectError(await call("/rest/Item?limit=5001"), 400, "Invalid limit. The maximum is 5000");
		await expectError(await call("/rest/Item?limit=99999999"), 400, /maximum/);
	});

	it("applies the default limit together with an offset", async () => {
		const body: any = await (await call("/rest/Item?fields=itemID&offset=2000")).json();
		expect(body.results).toHaveLength(5);
	});

	it("treats an empty limit or offset as absent", async () => {
		const body: any = await (await call("/rest/Item?fields=itemID&limit=&offset=")).json();
		expect(body.results).toHaveLength(2000);
	});
});

describe("reserved parameters are case-insensitive", () => {
	it.each(["limit", "Limit", "LIMIT"])("honours %s", async (name) => {
		const body: any = await (await call(`/rest/Item?${name}=1&sort_by=itemID`)).json();
		expect(body.results).toHaveLength(1);
	});

	it("honours SORT_BY, Order, Offset and Fields and never filters on them", async () => {
		const res = await call("/rest/Item?SORT_BY=itemID&Order=DESC&Offset=1&LIMIT=2&Fields=itemID");
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).results).toEqual([{ itemID: 3 }, { itemID: 2 }]);
	});

	it("still validates differently-cased reserved parameters", async () => {
		await expectError(await call("/rest/Item?Limit=abc"), 400, /limit/);
		await expectError(await call("/rest/Item?OFFSET=abc"), 400, /offset/);
		await expectError(await call("/rest/Item?FIELDS="), 400, /fields/);
	});

	it("rejects a reserved parameter that is sent twice", async () => {
		await expectError(await call("/rest/Item?limit=1&LIMIT=2"), 400, "Duplicate parameter: limit");
	});
});

describe("fields projection", () => {
	it("selects only the requested columns on the list", async () => {
		const body: any = await (await call("/rest/Item?active=1&fields=itemID,itemName")).json();
		expect(body.results).toHaveLength(3);
		for (const row of body.results) {
			expect(Object.keys(row).sort()).toEqual(["itemID", "itemName"]);
		}
	});

	it("does not treat fields as an equality filter", async () => {
		const body: any = await (await call("/rest/Item?fields=itemName")).json();
		expect(body.results).toHaveLength(4);
	});

	it("selects only the requested columns on by-id", async () => {
		const body: any = await (await call("/rest/Item/1?fields=itemID,itemDescription")).json();
		expect(body.results).toEqual([{ itemID: 1, itemDescription: "A very long description 1" }]);
	});

	it("removes duplicate and empty entries from the column list", async () => {
		const sqls: string[] = [];
		const res = await call("/rest/Item?fields=itemID,itemName,,itemID, itemName", {}, AUTH, spyBindings(sqls));
		expect(res.status).toBe(200);
		expect(sqls).toContain('SELECT "itemID", "itemName" FROM "Item" LIMIT ?');
	});

	it.each(["", ",", ",,", "itemName;DROP", "a b", "!!!", "item-Name", "item`Name", 'item"Name', "itemName--", "itémName", "itemName,item Name"])(
		"rejects fields=%j with 400",
		async (fields) => {
			await expectError(await call(`/rest/Item?fields=${encodeURIComponent(fields)}`), 400, /^Invalid fields/);
		}
	);

	it("rejects unknown columns with 400 instead of a database error", async () => {
		await expectError(await call("/rest/Item?fields=itemID,nope"), 400, "Unknown column: nope");
	});

	it("rejects keyword names that are not columns (quoted, so they are not a syntax error)", async () => {
		await expectError(await call("/rest/Item?fields=select"), 400, "Unknown column: select");
		await expectError(await call("/rest/Item?sort_by=limit"), 400, "Unknown column: limit");
	});
});

describe("invalid parameter names", () => {
	it.each([
		"item-Name", "item Name", "item--Name", "item`Name", 'item"Name', "item'Name", "itemName;", "itémName",
		"itemName%", "' OR 1=1--",
	])("rejects the filter name %j without rewriting it", async (key) => {
		// `itemName` would match "Cloak" if the name were silently sanitized
		const res = await call(`/rest/Item?${encodeURIComponent(key)}=Cloak`);
		const body = await expectError(res, 400, "Invalid parameter name");
		expect(JSON.stringify(body)).not.toContain(key);
	});

	it.each(["item-Name", "item Name", "item--Name", "itemName;DROP TABLE Item", "itemName`", 'itemName"', "itémName", "itemName ASC"])(
		"rejects sort_by=%j without rewriting it",
		async (sortBy) => {
			const body = await expectError(await call(`/rest/Item?sort_by=${encodeURIComponent(sortBy)}`), 400, "Invalid parameter name");
			expect(JSON.stringify(body)).not.toContain(sortBy);
		}
	);

	it("rejects an empty filter name", async () => {
		await expectError(await call("/rest/Item?=x"), 400, "Invalid parameter name");
	});

	it("rejects unknown filter and sort columns with 400 (case-sensitive names)", async () => {
		await expectError(await call("/rest/Item?nope=1"), 400, "Unknown column: nope");
		await expectError(await call("/rest/Item?itemname=Cloak"), 400, "Unknown column: itemname");
		await expectError(await call("/rest/Item?sort_by=nope"), 400, "Unknown column: nope");
		await expectError(await call("/rest/Item?sort_by=ITEMID"), 400, "Unknown column: ITEMID");
	});

	it("never changes the database on any of these requests", async () => {
		expect(await itemCount()).toBe(4);
		expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'Item'").first())).not.toBeNull();
	});
});

describe("ids and paths", () => {
	it.each(["1.0", "1e0", "abc", "+1", "%201", "1%20", "0x1", "99999999999999999999", "1,2", "--1", "1;"])(
		"rejects the id %j with 400",
		async (id) => {
			await expectError(await call(`/rest/Item/${id}`), 400, "Invalid id. Expected an integer");
		}
	);

	it("accepts plain, negative, zero-padded and percent-encoded integer ids", async () => {
		expect(((await (await call("/rest/Item/1")).json()) as any).results[0].itemID).toBe(1);
		expect(((await (await call("/rest/Item/01")).json()) as any).results[0].itemID).toBe(1);
		expect(((await (await call("/rest/Item/%32")).json()) as any).results[0].itemID).toBe(2);
		expect(((await (await call("/rest/Item/-1")).json()) as any).results).toEqual([]);
		expect(((await (await call("/rest/Item/-0")).json()) as any).results).toEqual([]);
	});

	it("rejects a non-integer itemID filter value", async () => {
		for (const value of ["1.0", "1e0", "abc", "", " 1", "1 OR 1=1"]) {
			await expectError(await call(`/rest/Item?itemID=${encodeURIComponent(value)}`), 400, "Invalid itemID. Expected an integer");
		}
		expect(((await (await call("/rest/Item?itemID=2")).json()) as any).results).toHaveLength(1);
	});

	it("decodes percent-encoded path segments", async () => {
		const res = await call("/rest/It%65m/1");
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).results[0].itemID).toBe(1);
	});

	it("rejects malformed percent-encoding with 400", async () => {
		await expectError(await call("/rest/It%ZZ"), 400, "Invalid URL encoding");
		await expectError(await call("/rest/Item/%E0%A4%A"), 400, "Invalid URL encoding");
	});

	it("tolerates one trailing slash", async () => {
		expect((await call("/rest/Item/")).status).toBe(200);
		expect((await call("/rest/Item/1/")).status).toBe(200);
	});

	it("returns 404 for extra or empty path segments", async () => {
		await expectError(await call("/rest/Item/1/extra"), 404, "Not found");
		await expectError(await call("/rest/Item/1/extra/more"), 404, "Not found");
		await expectError(await call("/rest//Item"), 404, "Not found");
		await expectError(await call("/rest/Item//1"), 404, "Not found");
		await expectError(await call("/rest/Item/1//"), 404, "Not found");
		await expectError(await send("PATCH", "/rest/Item/1/extra", { itemCost: 1 }), 404, "Not found");
		await expectError(await call("/rest/Item/1/extra", { method: "DELETE" }), 404, "Not found");
		expect(await itemRow(1)).not.toBeNull();
	});

	it("returns 400 when the table is missing", async () => {
		await expectError(await call("/rest"), 400, /Invalid path/);
		await expectError(await call("/rest/"), 400, /Invalid path/);
	});

	it.each([
		"Nope", "Ite-m", "Item%60", "Item%3BDROP", "Item%22", "Item%27", "%C4%B0tem", "Item%2F1", "1Item", "Item%20", "It%00em",
	])("returns 404 for the invalid or unknown table %j", async (table) => {
		await expectError(await call(`/rest/${table}`), 404, "Not found");
	});

	it("rejects an id on POST", async () => {
		await expectError(await send("POST", "/rest/Item/5", { itemID: 5 }), 400, "POST does not take an id");
	});
});

describe("table allowlist", () => {
	it.each(["sqlite_master", "sqlite_schema", "sqlite_sequence", "d1_migrations", "_cf_KV", "_cf_METADATA", "SQLITE_MASTER"])(
		"hides %s from every method",
		async (table) => {
			await expectError(await call(`/rest/${table}`), 404, "Not found");
			await expectError(await call(`/rest/${table}/1`), 404, "Not found");
			await expectError(await send("POST", `/rest/${table}`, { id: 1 }), 404, "Not found");
			await expectError(await send("PATCH", `/rest/${table}/1`, { id: 2 }), 404, "Not found");
			await expectError(await send("PUT", `/rest/${table}/1`, { id: 2 }), 404, "Not found");
			await expectError(await call(`/rest/${table}/1`, { method: "DELETE" }), 404, "Not found");
		}
	);

	it("does not treat Object prototype names as tables", async () => {
		await expectError(await call("/rest/constructor"), 404, "Not found");
		await expectError(await call("/rest/__proto__"), 404, "Not found");
		await expectError(await call("/rest/toString"), 404, "Not found");
	});

	it("keeps the migration bookkeeping rows intact", async () => {
		const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<{ n: number }>())!.n;
		await call("/rest/d1_migrations/1", { method: "DELETE" });
		const after = (await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<{ n: number }>())!.n;
		expect(after).toBe(before);
	});
});

describe("PATCH/PUT /rest/Item/:id", () => {
	it("updates by itemID with PATCH", async () => {
		const res = await send("PATCH", "/rest/Item/1", { itemCost: 750 });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ message: "Resource updated successfully", data: { itemCost: 750 } });
		expect((await itemRow(1))!.itemCost).toBe(750);
		expect((await itemRow(2))!.itemCost).toBe(0);
	});

	it("updates by itemID with PUT", async () => {
		const res = await send("PUT", "/rest/Item/4", { itemName: "Cloak of Protection" });
		expect(res.status).toBe(200);
		expect((await itemRow(4))!.itemName).toBe("Cloak of Protection");
	});

	it("updates several columns and stores null, booleans, text and numeric text", async () => {
		const res = await send("PATCH", "/rest/Item/1", { itemName: "New", itemRarity: null, active: false, itemCost: "42" });
		expect(res.status).toBe(200);
		const row = await itemRow(1);
		expect(row).toMatchObject({ itemName: "New", itemRarity: null, active: 0, itemCost: 42 });
		expect(typeof row!.itemCost).toBe("number");
	});

	it("stores SQL text in a value verbatim", async () => {
		await send("PATCH", "/rest/Item/1", { itemName: "x'; DROP TABLE Item; --" });
		expect((await itemRow(1))!.itemName).toBe("x'; DROP TABLE Item; --");
		expect(await itemCount()).toBe(4);
	});

	it("requires an id", async () => {
		await expectError(await send("PATCH", "/rest/Item", { itemCost: 1 }), 400, "ID is required for updates");
		await expectError(await send("PUT", "/rest/Item", { itemCost: 1 }), 400, "ID is required for updates");
	});

	it("returns 404 and changes nothing when the row does not exist", async () => {
		await expectError(await send("PATCH", "/rest/Item/999", { itemCost: 1 }), 404, "Not found");
		await expectError(await send("PUT", "/rest/Item/999", { itemCost: 1 }), 404, "Not found");
		expect(await itemRow(999)).toBeNull();
		expect(await itemCount()).toBe(4);
	});

	it("succeeds when the new values equal the old ones", async () => {
		expect((await send("PATCH", "/rest/Item/1", { itemCost: 500 })).status).toBe(200);
	});

	it.each([null, "5", 1.5, true, [1], { a: 1 }, "abc"])("refuses itemID=%j (would orphan or corrupt the row)", async (value) => {
		const res = await send("PATCH", "/rest/Item/1", { itemID: value });
		expect(res.status).toBe(400);
		expect(await itemRow(1)).not.toBeNull();
		expect(await itemCount()).toBe(4);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM Item WHERE itemID IS NULL").first<{ n: number }>())!.n).toBe(0);
	});

	it("can renumber a row with an integer itemID", async () => {
		expect((await send("PATCH", "/rest/Item/1", { itemID: 77 })).status).toBe(200);
		expect(await itemRow(1)).toBeNull();
		expect((await itemRow(77))!.itemName).toBe("Bag of Holding");
	});

	it("maps a duplicate itemID to 409", async () => {
		const body = await expectError(await send("PATCH", "/rest/Item/1", { itemID: 2 }), 409, /Duplicate/);
		expect(JSON.stringify(body)).not.toMatch(/SQLITE|UNIQUE|constraint/i);
		expect((await itemRow(1))!.itemName).toBe("Bag of Holding");
	});

	it("maps CHECK and NOT NULL violations to 422", async () => {
		const check = await expectError(await send("PATCH", "/rest/Item/1", { active: 2 }), 422, "Value violates a table constraint");
		expect(JSON.stringify(check)).not.toMatch(/SQLITE|CHECK/);
		await expectError(await send("PATCH", "/rest/Item/1", { active: null }), 422, "Value violates a table constraint");
		expect((await itemRow(1))!.active).toBe(1);
	});
});

describe("DELETE /rest/Item/:id", () => {
	it("deletes by itemID", async () => {
		const res = await call("/rest/Item/3", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ message: "Resource deleted successfully" });
		expect(await itemRow(3)).toBeNull();
		expect(await itemRow(1)).not.toBeNull();
	});

	it("requires an id and deletes nothing without one", async () => {
		await expectError(await call("/rest/Item", { method: "DELETE" }), 400, "ID is required for deletion");
		expect(await itemCount()).toBe(4);
	});

	it("returns 404 when the row does not exist", async () => {
		await expectError(await call("/rest/Item/999", { method: "DELETE" }), 404, "Not found");
		expect(await itemCount()).toBe(4);
	});

	it("deletes a row only once", async () => {
		expect((await call("/rest/Item/3", { method: "DELETE" })).status).toBe(200);
		expect((await call("/rest/Item/3", { method: "DELETE" })).status).toBe(404);
	});

	it("rejects a non-integer id and deletes nothing", async () => {
		await expectError(await call("/rest/Item/1.0", { method: "DELETE" }), 400, "Invalid id. Expected an integer");
		await expectError(await call("/rest/Item/1e0", { method: "DELETE" }), 400, "Invalid id. Expected an integer");
		expect(await itemCount()).toBe(4);
	});
});

describe("POST /rest/Item", () => {
	it("creates an item using the values sent", async () => {
		const body = { itemID: 10, itemName: "New Thing", itemRarity: "Rare", itemCost: 5, itemType: "Wondrous", itemUrl: "https://x.test", active: 0 };
		const res = await send("POST", "/rest/Item", body);
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ message: "Resource created successfully", data: body });
		// every value lands in the column named by its key
		expect(await itemRow(10)).toMatchObject(body);
	});

	it("defaults the columns that are not sent", async () => {
		await send("POST", "/rest/Item", { itemID: 10, itemName: "New Thing" });
		expect((await itemRow(10))!.active).toBe(1);
	});

	it("stores booleans as 0/1, numeric text in integer columns, and text verbatim", async () => {
		await send("POST", "/rest/Item", { itemID: 11, active: true, itemCost: "7", itemName: "<b>é ' \" `; --</b>" });
		expect(await itemRow(11)).toMatchObject({ active: 1, itemCost: 7, itemName: "<b>é ' \" `; --</b>" });
	});

	it("requires the primary key: a row without itemID would be unreachable", async () => {
		await expectError(await send("POST", "/rest/Item", { itemName: "orphan" }), 400, "Missing primary key: itemID");
		expect(await itemCount()).toBe(4);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM Item WHERE itemID IS NULL").first<{ n: number }>())!.n).toBe(0);
	});

	it.each([null, "5", 1.5, true, [5], { a: 1 }, 1e300, "abc"])("refuses itemID=%j", async (value) => {
		const res = await send("POST", "/rest/Item", { itemID: value, itemName: "bad" });
		expect(res.status).toBe(400);
		expect(await itemCount()).toBe(4);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM Item WHERE itemID IS NULL").first<{ n: number }>())!.n).toBe(0);
	});

	it("maps a duplicate itemID to 409 without database text", async () => {
		const body = await expectError(await send("POST", "/rest/Item", { itemID: 1, itemName: "Duplicate key" }), 409, /Duplicate/);
		expect(JSON.stringify(body)).not.toMatch(/SQLITE|UNIQUE|constraint|Item\./i);
		expect((await itemRow(1))!.itemName).toBe("Bag of Holding");
	});

	it("maps CHECK and NOT NULL violations to 422", async () => {
		await expectError(await send("POST", "/rest/Item", { itemID: 20, active: 2 }), 422, "Value violates a table constraint");
		await expectError(await send("POST", "/rest/Item", { itemID: 20, active: null }), 422, "Value violates a table constraint");
		expect(await itemRow(20)).toBeNull();
	});
});

describe("write body validation", () => {
	it.each(["POST", "PUT", "PATCH"])("%s with invalid JSON returns 400", async (method) => {
		const path = method === "POST" ? "/rest/Item" : "/rest/Item/1";
		const res = await send(method, path, "{not json");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ success: false, error: "Invalid JSON body" });
	});

	it("rejects non-object bodies and empty objects with 400", async () => {
		await expectError(await send("POST", "/rest/Item", "[1,2]"), 400, "Invalid data format");
		await expectError(await send("POST", "/rest/Item", '"text"'), 400, "Invalid data format");
		await expectError(await send("POST", "/rest/Item", "{}"), 400, "No fields provided");
		await expectError(await send("PATCH", "/rest/Item/1", "null"), 400, "Invalid data format");
		await expectError(await send("PATCH", "/rest/Item/1", "{}"), 400, "No fields provided");
	});

	it.each([
		["array", [1, 2]],
		["empty array", []],
		["object", { a: 1 }],
		["nested object", { a: { b: 1 } }],
	])("rejects a %s value with 400 naming the column", async (_name, value) => {
		for (const [method, path, extra] of [["POST", "/rest/Item", { itemID: 30 }], ["PATCH", "/rest/Item/1", {}]] as const) {
			const body = await expectError(await send(method, path, { ...extra, itemName: value }), 400, /^Invalid value for column: itemName/);
			expect(body.error).toContain("itemName");
		}
		expect(await itemRow(30)).toBeNull();
		expect((await itemRow(1))!.itemName).toBe("Bag of Holding");
	});

	it("rejects non-finite numbers", async () => {
		await expectError(await send("PATCH", "/rest/Item/1", '{"itemName": 1e999}'), 400, /^Invalid value for column: itemName/);
		await expectError(await send("PATCH", "/rest/Item/1", '{"itemCost": -1e999}'), 400, /^Invalid value for column: itemCost/);
	});

	it("rejects text and fractions in integer columns", async () => {
		await expectError(await send("PATCH", "/rest/Item/1", { itemCost: "abc" }), 400, "Invalid value for column: itemCost. Expected an integer");
		await expectError(await send("PATCH", "/rest/Item/1", { itemCost: 1.5 }), 400, "Invalid value for column: itemCost. Expected an integer");
		await expectError(await send("PATCH", "/rest/Item/1", { itemCost: "1.5" }), 400, "Invalid value for column: itemCost. Expected an integer");
		await expectError(await send("PATCH", "/rest/Item/1", { itemCost: "" }), 400, "Invalid value for column: itemCost. Expected an integer");
		await expectError(await send("POST", "/rest/Item", { itemID: 31, itemCost: "abc" }), 400, /itemCost/);
		expect((await itemRow(1))!.itemCost).toBe(500);
		expect(await itemRow(31)).toBeNull();
	});

	it("allows null in an integer column", async () => {
		expect((await send("PATCH", "/rest/Item/1", { itemCost: null })).status).toBe(200);
		expect((await itemRow(1))!.itemCost).toBeNull();
	});

	it.each([
		"item Name", "item-Name", "item--Name", "item`Name", 'item"Name', "itemName;", "itémName", "", " itemName", "itemName ",
	])("rejects the column name %j instead of rewriting it", async (key) => {
		for (const [method, path, extra] of [["POST", "/rest/Item", { itemID: 40 }], ["PATCH", "/rest/Item/1", {}]] as const) {
			const body = await expectError(await send(method, path, { ...extra, [key]: "written" }), 400, "Invalid column name");
			expect(JSON.stringify(body)).not.toContain(key === "" ? "\u0000" : key);
		}
		expect(await itemRow(40)).toBeNull();
		expect((await itemRow(1))!.itemName).toBe("Bag of Holding");
	});

	it("rejects colliding keys instead of merging them", async () => {
		await expectError(await send("PATCH", "/rest/Item/1", { itemName: "a", "item Name": "b" }), 400, "Invalid column name");
		await expectError(await send("PATCH", "/rest/Item/1", { itemName: "a", ITEMNAME: "b" }), 400, "Unknown column: ITEMNAME");
		expect((await itemRow(1))!.itemName).toBe("Bag of Holding");
	});

	it("rejects unknown columns with 400 instead of a database error", async () => {
		await expectError(await send("POST", "/rest/Item", { itemID: 50, nope: 1 }), 400, "Unknown column: nope");
		await expectError(await send("PATCH", "/rest/Item/1", { nope: 1 }), 400, "Unknown column: nope");
		await expectError(await send("PATCH", "/rest/Item/1", '{"__proto__": 1}'), 400, "Unknown column: __proto__");
		expect(await itemRow(50)).toBeNull();
	});
});

describe("methods", () => {
	// The Request constructor and Hono only let standard methods through (Hono serves HEAD as
	// GET), so the fallback is exercised by calling the handler with a minimal context.
	function fakeContext(method: string) {
		return {
			env,
			req: { method, url: "https://example.com/rest/Item", json: async () => ({}) },
			json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
		} as any;
	}

	it.each(["TRACE", "CONNECT", "FOO", "OPTIONS", "HEAD", "get"])("returns 405 for %s", async (method) => {
		await expectError(await handleRest(fakeContext(method)), 405, "Method not allowed");
	});

	it("does not write anything on an unsupported method", async () => {
		await handleRest(fakeContext("TRACE"));
		expect(await itemCount()).toBe(4);
	});

	it("handles the five supported methods", async () => {
		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
			expect((await handleRest(fakeContext(method))).status).not.toBe(405);
		}
	});
});

describe("unexpected database errors", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns a generic 500 and logs the detail instead of returning it", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const secretText = "D1_ERROR: no such table: secret_table: SQLITE_ERROR";
		const bindings = failingBindings(secretText);
		const requests: [string, RequestInit][] = [
			["/rest/Item", {}],
			["/rest/Item/1", {}],
			["/rest/Item", { method: "POST", body: '{"itemID": 60}' }],
			["/rest/Item/1", { method: "PATCH", body: '{"itemCost": 1}' }],
			["/rest/Item/1", { method: "DELETE" }],
		];
		for (const [path, init] of requests) {
			const res = await call(path, init, AUTH, bindings);
			const body = await expectError(res, 500, "Internal server error");
			expect(JSON.stringify(body)).not.toContain("secret_table");
		}
		expect(logged).toHaveBeenCalledTimes(requests.length);
		expect(String(logged.mock.calls[0])).toContain("secret_table");
	});
});

// The generic code path is exercised with throwaway tables added to the allowlist for
// these tests only (production allows just Item).
describe("other allowlisted tables", () => {
	beforeEach(async () => {
		TABLES.Thing = { primaryKey: "id" };
		TABLES.Order = { primaryKey: "id" };
		await env.DB.exec("DROP TABLE IF EXISTS Thing");
		await env.DB.exec("CREATE TABLE Thing (id INTEGER PRIMARY KEY, name TEXT)");
		await env.DB.exec('DROP TABLE IF EXISTS "Order"');
		await env.DB.exec('CREATE TABLE "Order" (id INTEGER PRIMARY KEY, "select" TEXT, "group" INTEGER)');
	});
	afterEach(() => {
		delete TABLES.Thing;
		delete TABLES.Order;
	});

	it("uses the configured primary key for every by-id route", async () => {
		expect((await send("POST", "/rest/Thing", { id: 7, name: "a" })).status).toBe(201);
		expect(((await (await call("/rest/Thing/7")).json()) as any).results[0].name).toBe("a");
		expect((await send("PATCH", "/rest/Thing/7", { name: "b" })).status).toBe(200);
		expect(((await (await call("/rest/Thing/7")).json()) as any).results[0].name).toBe("b");
		expect((await call("/rest/Thing/7", { method: "DELETE" })).status).toBe(200);
		expect(((await (await call("/rest/Thing")).json()) as any).results).toEqual([]);
	});

	it("answers 405 to writes on readOnly tables but still reads them", async () => {
		TABLES.Thing = { primaryKey: "id", readOnly: true };
		await env.DB.exec("INSERT INTO Thing (id, name) VALUES (1, 'a')");
		expect(((await (await call("/rest/Thing/1")).json()) as any).results[0].name).toBe("a");
		for (const [method, path] of [["POST", "/rest/Thing"], ["PATCH", "/rest/Thing/1"], ["PUT", "/rest/Thing/1"], ["DELETE", "/rest/Thing/1"]]) {
			const res = await send(method, path, { id: 2, name: "b" });
			expect(res.status, `${method} ${path}`).toBe(405);
			expect(res.headers.get("Allow")).toBe("GET");
		}
		expect(((await (await call("/rest/Thing")).json()) as any).results).toHaveLength(1);
	});

	it("also requires the primary key on POST", async () => {
		await expectError(await send("POST", "/rest/Thing", { name: "a" }), 400, "Missing primary key: id");
	});

	it("quotes keyword table and column names", async () => {
		expect((await send("POST", "/rest/Order", { id: 1, select: "x", group: 2 })).status).toBe(201);
		expect((await send("POST", "/rest/Order", { id: 2, select: "y", group: 1 })).status).toBe(201);
		const body: any = await (await call("/rest/Order?fields=select,group&sort_by=group&order=desc&select=x")).json();
		expect(body.results).toEqual([{ select: "x", group: 2 }]);
		const sorted: any = await (await call("/rest/Order?sort_by=group")).json();
		expect(sorted.results.map((r: any) => r.id)).toEqual([2, 1]);
		expect((await send("PATCH", "/rest/Order/1", { select: "z" })).status).toBe(200);
		expect((await call("/rest/Order/2", { method: "DELETE" })).status).toBe(200);
	});

	it("picks up a column added after the column list was cached", async () => {
		expect((await call("/rest/Thing?fields=name")).status).toBe(200); // caches the columns
		await expectError(await call("/rest/Thing?fields=extra"), 400, "Unknown column: extra");
		await env.DB.exec("ALTER TABLE Thing ADD COLUMN extra TEXT");
		expect((await call("/rest/Thing?fields=extra")).status).toBe(200);
		expect((await send("POST", "/rest/Thing", { id: 1, extra: "e" })).status).toBe(201);
	});
});
