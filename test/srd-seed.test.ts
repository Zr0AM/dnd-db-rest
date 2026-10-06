import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { seed } from "./helpers";

// Applies seed/srd/*.sql (the SRD 5.2.1 data for the 0003 tables) to the local D1,
// the same files an owner runs with `wrangler d1 execute --file`.
async function applySeeds() {
	for (const file of env.TEST_SRD_SEEDS) {
		const statements = file.queries.map((q) => env.DB.prepare(q));
		for (let i = 0; i < statements.length; i += 100) {
			await env.DB.batch(statements.slice(i, i + 100));
		}
	}
}

const count = async (table: string) =>
	(await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>())!.n;

const SEEDED: Record<string, number> = {
	Source: 1,
	Ability: 6,
	Skill: 18,
	DamageType: 13,
	Condition: 15,
	CreatureSize: 6,
	CreatureType: 14,
	ChallengeRating: 34,
	CharacterLevel: 20,
	Rarity: 6,
	ItemCategory: 9,
	Equipment: 182,
	Weapon: 38,
	Armor: 13,
	Class: 12,
	Subclass: 12,
	ClassFeature: 232,
	Spell: 339,
	Feat: 17,
	Species: 9,
	Background: 4,
	Poison: 14,
	Monster: 341,
};

describe("SRD seed data", () => {
	beforeAll(async () => {
		await seed(); // Items 1–4, including "Bag of Holding" for the backfill
		await applySeeds();
	});

	it("loads every seed file in order", () => {
		expect(env.TEST_SRD_SEEDS.map((f) => f.name)).toEqual([
			"01-reference.sql",
			"02-equipment.sql",
			"03-classes.sql",
			"04-spells.sql",
			"05-origins.sql",
			"06-monsters.sql",
			"07-items-backfill.sql",
		]);
	});

	it("fills the tables with the SRD 5.2.1 rows", async () => {
		for (const [table, n] of Object.entries(SEEDED)) {
			expect({ table, n: await count(table) }).toEqual({ table, n });
		}
	});

	it("leaves no foreign key dangling", async () => {
		const { results } = await env.DB.prepare("PRAGMA foreign_key_check").all();
		expect(results).toEqual([]);
	});

	it("is idempotent: applying the seeds again changes no row count", async () => {
		const before = Object.fromEntries(await Promise.all(Object.keys(SEEDED).map(async (t) => [t, await count(t)])));
		const monsterActions = await count("MonsterAction");
		await applySeeds();
		for (const table of Object.keys(SEEDED)) expect(await count(table)).toBe(before[table]);
		expect(await count("MonsterAction")).toBe(monsterActions);
	});

	it("backfills a matching Item row and leaves the others alone", async () => {
		const bag = await env.DB
			.prepare(
				`SELECT i.itemSlug, r.rarityName, c.categoryName, i.itemRequiresAttunement, i.itemCost
				   FROM Item i JOIN Rarity r USING (rarityID) JOIN ItemCategory c USING (categoryID)
				  WHERE i.itemID = 1`
			)
			.first();
		expect(bag).toEqual({
			itemSlug: "bag-of-holding",
			rarityName: "Uncommon",
			categoryName: "Wondrous Item",
			itemRequiresAttunement: 0,
			itemCost: 500, // Market data is untouched
		});
		const other = await env.DB.prepare("SELECT itemSlug, rarityID FROM Item WHERE itemID = 3").first();
		expect(other).toEqual({ itemSlug: null, rarityID: null });
	});

	it("serves the read views", async () => {
		const monster = await env.DB
			.prepare("SELECT monsterName, creatureTypeName, crLabel, xp, monsterSizes FROM MonsterListView WHERE monsterSlug = 'assassin'")
			.first();
		expect(monster).toEqual({ monsterName: "Assassin", creatureTypeName: "Humanoid", crLabel: "8", xp: 3900, monsterSizes: expect.stringMatching(/Small|Medium/) });
		const spell = await env.DB.prepare("SELECT spellLevel, schoolName FROM SpellListView WHERE spellSlug = 'fireball'").first();
		expect(spell).toEqual({ spellLevel: 3, schoolName: "Evocation" });
	});
});
