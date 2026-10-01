import { env } from "cloudflare:workers";
import app from "../src/index";

export const SECRET_VALUE = "test-secret-not-real";
export const AUTH = { Authorization: `Bearer ${SECRET_VALUE}` };

/** Runs the real Hono app against the local D1 + local secrets store bindings. */
export function call(
	path: string,
	init: RequestInit = {},
	auth: Record<string, string> = AUTH,
	bindings: Record<string, unknown> = env as unknown as Record<string, unknown>
) {
	return app.fetch(
		new Request(`https://example.com${path}`, {
			...init,
			headers: { ...auth, ...(init.headers as Record<string, string>) },
		}),
		bindings
	);
}

export function send(method: string, path: string, body: unknown) {
	return call(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

export async function seed() {
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

export async function itemRow(id: number) {
	return env.DB.prepare("SELECT * FROM Item WHERE itemID = ?").bind(id).first<Record<string, unknown>>();
}

export async function itemCount() {
	return (await env.DB.prepare("SELECT COUNT(*) AS n FROM Item").first<{ n: number }>())!.n;
}

export async function expectError(res: Response, status: number, error?: string | RegExp) {
	const body: any = await res.json();
	if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(body)}`);
	if (body.success !== false) throw new Error(`expected success:false, got ${JSON.stringify(body)}`);
	if (typeof error === "string" && body.error !== error) throw new Error(`expected error ${JSON.stringify(error)}, got ${JSON.stringify(body.error)}`);
	if (error instanceof RegExp && !error.test(body.error)) throw new Error(`error ${JSON.stringify(body.error)} does not match ${error}`);
	return body;
}
