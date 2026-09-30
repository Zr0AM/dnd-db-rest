import { env } from "cloudflare:workers";
import app from "../src/index";
import { beforeEach, describe, expect, it } from "vitest";

const AUTH = { Authorization: "Bearer test-secret-not-real" };

function call(path: string, init: RequestInit = {}, auth: Record<string, string> = AUTH) {
	// Runs the real Hono app against the local D1 + local secrets store bindings
	return app.fetch(
		new Request(`https://example.com${path}`, {
			...init,
			headers: { ...auth, ...(init.headers as Record<string, string>) },
		}),
		env
	);
}

function send(method: string, path: string, body: unknown) {
	return call(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

async function seed() {
	await env.DB.prepare("DELETE FROM Item").run();
	const insert = env.DB.prepare(
		"INSERT INTO Item (itemID, itemName, itemRarity, itemCost, active, itemDescription) VALUES (?, ?, ?, ?, ?, ?)"
	);
	await env.DB.batch([
		insert.bind(1, "Bag of Holding", "Uncommon", 500, 1, "A very long description 1"),
		insert.bind(2, "Vorpal Sword", "Legendary", 0, 1, "A very long description 2"),
		insert.bind(3, "Retired Item", "Common", 10, 0, "A very long description 3"),
		insert.bind(4, "Cloak", "Rare", 300, 1, "A very long description 4"),
	]);
}

async function itemRow(id: number) {
	return env.DB.prepare("SELECT * FROM Item WHERE itemID = ?").bind(id).first<Record<string, unknown>>();
}

beforeEach(seed);

describe("migrations", () => {
	it("creates the Item table with all 14 columns", async () => {
		const { results } = await env.DB.prepare("PRAGMA table_info(Item)").all<{ name: string }>();
		expect(results.map((r) => r.name)).toEqual([
			"itemID", "itemName", "itemRarity", "itemCost", "itemType", "itemRestrictions",
			"itemAttunement", "itemSource", "itemUrl", "itemVisualDesc", "itemShopkeeperDesc",
			"active", "itemDescription", "itemDescriptionSource",
		]);
	});
});

describe("authentication", () => {
	it("returns 401 without a token", async () => {
		const res = await call("/rest/Item", {}, {});
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ success: false, error: "Unauthorized" });
	});

	it("returns 401 with a wrong token", async () => {
		const res = await call("/rest/Item", {}, { Authorization: "Bearer nope" });
		expect(res.status).toBe(401);
	});

	it("returns 200 with the right token (Bearer or bare)", async () => {
		expect((await call("/rest/Item")).status).toBe(200);
		expect((await call("/rest/Item", {}, { Authorization: "test-secret-not-real" })).status).toBe(200);
	});

	it("leaves the root status route open", async () => {
		const res = await call("/", {}, {});
		expect(res.status).toBe(200);
	});
});

describe("GET /rest/Item", () => {
	it("keeps the D1 response shape on success", async () => {
		const body: any = await (await call("/rest/Item")).json();
		expect(body.success).toBe(true);
		expect(body.results).toHaveLength(4);
	});

	it("filters with active=1", async () => {
		const body: any = await (await call("/rest/Item?active=1")).json();
		expect(body.results.map((r: any) => r.itemID).sort()).toEqual([1, 2, 4]);
	});

	it("gets one item by itemID", async () => {
		const body: any = await (await call("/rest/Item/2")).json();
		expect(body.results).toHaveLength(1);
		expect(body.results[0].itemName).toBe("Vorpal Sword");
		expect(body.results[0].itemDescription).toBe("A very long description 2");
	});

	it("resolves the primary key case-insensitively on the table name", async () => {
		const body: any = await (await call("/rest/item/2")).json();
		expect(body.results[0].itemID).toBe(2);
	});

	it("returns an empty result for an unknown id", async () => {
		const res = await call("/rest/Item/999");
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).results).toEqual([]);
	});

	it("sorts and paginates", async () => {
		const body: any = await (await call("/rest/Item?sort_by=itemID&order=desc&limit=2&offset=1")).json();
		expect(body.results.map((r: any) => r.itemID)).toEqual([3, 2]);
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

	it.each(["", ",", ",,", "itemName;DROP", "a b", "!!!"])("rejects fields=%j with 400", async (fields) => {
		const res = await call(`/rest/Item?fields=${encodeURIComponent(fields)}`);
		expect(res.status).toBe(400);
		const body: any = await res.json();
		expect(body.success).toBe(false);
		expect(typeof body.error).toBe("string");
	});
});

describe("limit and offset", () => {
	it.each(["abc", "-1", "1.5", "1e3", "99999999999999999999"])("rejects limit=%s with 400", async (v) => {
		const res = await call(`/rest/Item?limit=${v}`);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toMatch(/limit/);
	});

	it.each(["abc", "-1", "1.5"])("rejects offset=%s with 400", async (v) => {
		const res = await call(`/rest/Item?offset=${v}`);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toMatch(/offset/);
	});

	it("supports limit=0", async () => {
		const body: any = await (await call("/rest/Item?limit=0")).json();
		expect(body.results).toEqual([]);
	});

	it("applies offset on its own", async () => {
		const body: any = await (await call("/rest/Item?sort_by=itemID&offset=1")).json();
		expect(body.results.map((r: any) => r.itemID)).toEqual([2, 3, 4]);
	});
});

describe("PATCH/PUT /rest/Item/:id", () => {
	it("updates by itemID with PATCH", async () => {
		const res = await send("PATCH", "/rest/Item/1", { itemCost: 750 });
		expect(res.status).toBe(200);
		expect((await itemRow(1))!.itemCost).toBe(750);
		expect((await itemRow(2))!.itemCost).toBe(0);
	});

	it("updates by itemID with PUT", async () => {
		const res = await send("PUT", "/rest/Item/4", { itemName: "Cloak of Protection" });
		expect(res.status).toBe(200);
		expect((await itemRow(4))!.itemName).toBe("Cloak of Protection");
	});

	it("requires an id", async () => {
		expect((await send("PATCH", "/rest/Item", { itemCost: 1 })).status).toBe(400);
	});
});

describe("DELETE /rest/Item/:id", () => {
	it("deletes by itemID", async () => {
		const res = await call("/rest/Item/3", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await itemRow(3)).toBeNull();
		expect(await itemRow(1)).not.toBeNull();
	});
});

describe("POST /rest/Item", () => {
	it("creates an item using the values sent", async () => {
		const res = await send("POST", "/rest/Item", { itemID: 10, itemName: "New Thing", itemCost: 5 });
		expect(res.status).toBe(201);
		const row = await itemRow(10);
		expect(row!.itemName).toBe("New Thing");
		expect(row!.active).toBe(1);
	});

	it("reports database errors as 500 with the error shape", async () => {
		const res = await send("POST", "/rest/Item", { itemID: 1, itemName: "Duplicate key" });
		expect(res.status).toBe(500);
		const body: any = await res.json();
		expect(body.success).toBe(false);
		expect(typeof body.error).toBe("string");
	});
});

describe("invalid request bodies", () => {
	it.each(["POST", "PUT", "PATCH"])("%s with invalid JSON returns 400", async (method) => {
		const path = method === "POST" ? "/rest/Item" : "/rest/Item/1";
		const res = await send(method, path, "{not json");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ success: false, error: "Invalid JSON body" });
	});

	it("rejects non-object bodies and empty objects with 400", async () => {
		expect((await send("POST", "/rest/Item", "[1,2]")).status).toBe(400);
		expect((await send("POST", "/rest/Item", "{}")).status).toBe(400);
		expect((await send("PATCH", "/rest/Item/1", "null")).status).toBe(400);
	});
});

describe("other tables", () => {
	it("keeps `id` as the default primary key", async () => {
		await env.DB.exec("CREATE TABLE IF NOT EXISTS Thing (id INTEGER PRIMARY KEY, name TEXT)");
		await env.DB.exec("DELETE FROM Thing");
		expect((await send("POST", "/rest/Thing", { id: 7, name: "a" })).status).toBe(201);
		expect(((await (await call("/rest/Thing/7")).json()) as any).results[0].name).toBe("a");
		expect((await send("PATCH", "/rest/Thing/7", { name: "b" })).status).toBe(200);
		expect(((await (await call("/rest/Thing/7")).json()) as any).results[0].name).toBe("b");
		expect((await call("/rest/Thing/7", { method: "DELETE" })).status).toBe(200);
		expect(((await (await call("/rest/Thing")).json()) as any).results).toEqual([]);
	});

	it("still returns 500 for an unknown table", async () => {
		expect((await call("/rest/Nope")).status).toBe(500);
	});
});
