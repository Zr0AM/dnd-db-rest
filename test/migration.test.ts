import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { itemCount, itemRow, seed } from "./helpers";

beforeEach(seed);

describe("migrations", () => {
	it("applies every file in migrations/ in order", async () => {
		const names = ["0001_baseline.sql", "0002_item_id_guard.sql", "0003_game_data_tables.sql"];
		expect(env.TEST_MIGRATIONS.map((m) => m.name)).toEqual(names);
		const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
		expect(results.map((r) => r.name)).toEqual(names);
	});

	it("creates the two itemID guard triggers", async () => {
		const { results } = await env.DB
			.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
			.all<{ name: string; tbl_name: string }>();
		expect(results).toEqual([
			{ name: "Item_itemID_not_null_on_insert", tbl_name: "Item" },
			{ name: "Item_itemID_not_null_on_update", tbl_name: "Item" },
		]);
	});

	it("is idempotent: running the file again changes nothing and does not fail", async () => {
		const guard = env.TEST_MIGRATIONS.find((m) => m.name === "0002_item_id_guard.sql")!;
		for (const query of guard.queries) await env.DB.prepare(query).run();
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); // already recorded: a no-op
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").first<{ n: number }>();
		expect(count!.n).toBe(2);
	});
});

describe("Item.itemID guard triggers", () => {
	const aborted = /itemID must not be NULL/;

	it("rejects an INSERT with a NULL itemID", async () => {
		await expect(env.DB.prepare("INSERT INTO Item (itemID, itemName) VALUES (NULL, 'orphan')").run()).rejects.toThrow(aborted);
		await expect(env.DB.prepare("INSERT INTO Item (itemID, itemName) VALUES (?, 'orphan')").bind(null).run()).rejects.toThrow(aborted);
	});

	it("rejects an INSERT that omits itemID", async () => {
		await expect(env.DB.prepare("INSERT INTO Item (itemName) VALUES ('orphan')").run()).rejects.toThrow(aborted);
	});

	it("rejects INSERT OR REPLACE / OR IGNORE with a NULL itemID", async () => {
		await expect(env.DB.prepare("INSERT OR REPLACE INTO Item (itemID, itemName) VALUES (NULL, 'x')").run()).rejects.toThrow(aborted);
		await expect(env.DB.prepare("INSERT OR IGNORE INTO Item (itemID, itemName) VALUES (NULL, 'x')").run()).rejects.toThrow(aborted);
	});

	it("rejects an UPDATE that sets itemID to NULL", async () => {
		await expect(env.DB.prepare("UPDATE Item SET itemID = NULL WHERE itemID = 2").run()).rejects.toThrow(aborted);
		await expect(env.DB.prepare("UPDATE Item SET itemID = ? WHERE itemID = 2").bind(null).run()).rejects.toThrow(aborted);
		expect((await itemRow(2))!.itemName).toBe("Vorpal Sword");
	});

	it("rolls back a whole batch containing a NULL itemID", async () => {
		const insert = env.DB.prepare("INSERT INTO Item (itemID, itemName) VALUES (?, 'b')");
		await expect(env.DB.batch([insert.bind(100), insert.bind(null)])).rejects.toThrow(aborted);
		expect(await itemRow(100)).toBeNull();
		expect(await itemCount()).toBe(4);
	});

	it("does not get in the way of normal writes", async () => {
		await env.DB.prepare("INSERT INTO Item (itemID, itemName) VALUES (50, 'ok')").run();
		await env.DB.prepare("UPDATE Item SET itemName = 'renamed', itemCost = 9 WHERE itemID = 50").run();
		await env.DB.prepare("UPDATE Item SET itemID = 51 WHERE itemID = 50").run();
		expect((await itemRow(51))!.itemName).toBe("renamed");
		await env.DB.prepare("DELETE FROM Item WHERE itemID = 51").run();
		expect(await itemRow(51)).toBeNull();
	});
});
