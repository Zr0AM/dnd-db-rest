import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECRET_VALUE, call, expectError, seed } from "./helpers";

beforeEach(seed);
afterEach(() => vi.restoreAllMocks());

/** Bindings with a secrets store stub that counts how often it is read. */
function secretStub(value: string | null, calls = { n: 0 }) {
	return {
		calls,
		bindings: {
			DB: env.DB,
			SECRET: {
				get: async () => {
					calls.n++;
					return value as string;
				},
			},
		},
	};
}

describe("authentication", () => {
	it("returns 401 without a token", async () => {
		const res = await call("/rest/Item", {}, {});
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ success: false, error: "Unauthorized" });
	});

	it("returns 401 with a wrong token", async () => {
		await expectError(await call("/rest/Item", {}, { Authorization: "Bearer nope" }), 401, "Unauthorized");
	});

	it("returns 200 with the right token (Bearer or bare)", async () => {
		expect((await call("/rest/Item")).status).toBe(200);
		expect((await call("/rest/Item", {}, { Authorization: SECRET_VALUE })).status).toBe(200);
	});

	it("accepts the Bearer scheme in any case and with extra spaces", async () => {
		for (const header of [`bearer ${SECRET_VALUE}`, `BEARER ${SECRET_VALUE}`, `BeArEr ${SECRET_VALUE}`, `Bearer   ${SECRET_VALUE}`, `Bearer\t${SECRET_VALUE}`]) {
			expect((await call("/rest/Item", {}, { Authorization: header })).status, header).toBe(200);
		}
	});

	it("rejects a token that only starts with the secret (no prefix match)", async () => {
		await expectError(await call("/rest/Item", {}, { Authorization: `Bearer ${SECRET_VALUE}x` }), 401);
		await expectError(await call("/rest/Item", {}, { Authorization: `Bearer ${SECRET_VALUE} extra` }), 401);
		await expectError(await call("/rest/Item", {}, { Authorization: `${SECRET_VALUE}${SECRET_VALUE}` }), 401);
	});

	it("rejects a token that the secret starts with (no truncated match)", async () => {
		await expectError(await call("/rest/Item", {}, { Authorization: `Bearer ${SECRET_VALUE.slice(0, -1)}` }), 401);
		await expectError(await call("/rest/Item", {}, { Authorization: `Bearer ${SECRET_VALUE.slice(0, 1)}` }), 401);
	});

	it("rejects a token of the same length with different content", async () => {
		const sameLength = "x".repeat(SECRET_VALUE.length);
		await expectError(await call("/rest/Item", {}, { Authorization: `Bearer ${sameLength}` }), 401);
		const lastCharChanged = SECRET_VALUE.slice(0, -1) + (SECRET_VALUE.endsWith("a") ? "b" : "a");
		await expectError(await call("/rest/Item", {}, { Authorization: `Bearer ${lastCharChanged}` }), 401);
		await expectError(await call("/rest/Item", {}, { Authorization: `Bearer ${SECRET_VALUE.toUpperCase()}` }), 401);
	});

	it("rejects an empty token and other schemes", async () => {
		for (const header of ["Bearer", "Bearer ", "Bearer  ", "Basic dGVzdDp0ZXN0", "   "]) {
			expect((await call("/rest/Item", {}, { Authorization: header })).status, header).toBe(401);
		}
	});

	it("protects /query and every /rest route", async () => {
		expect((await call("/query", { method: "POST", body: "{}" }, {})).status).toBe(401);
		expect((await call("/rest/Item/1", { method: "DELETE" }, {})).status).toBe(401);
		expect((await call("/rest/Item", { method: "POST", body: '{"itemID": 99}' }, {})).status).toBe(401);
		expect((await call("/rest/Unknown", {}, {})).status).toBe(401);
	});

	it("leaves the root status route open", async () => {
		const res = await call("/", {}, {});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok", service: "dnd-db-rest" });
	});

	it("does not read the Secrets Store for unauthenticated requests", async () => {
		const { calls, bindings } = secretStub(SECRET_VALUE);
		expect((await call("/rest/Item", {}, {}, bindings)).status).toBe(401);
		expect((await call("/rest/Item", {}, { Authorization: "Bearer " }, bindings)).status).toBe(401);
		expect(calls.n).toBe(0);
		expect((await call("/rest/Item", {}, { Authorization: "Bearer nope" }, bindings)).status).toBe(401);
		expect(calls.n).toBe(1);
		expect((await call("/rest/Item", {}, undefined, bindings)).status).toBe(200);
		expect(calls.n).toBe(2);
	});

	it.each([["empty", ""], ["missing", null]])("never authenticates when the secret is %s", async (_name, value) => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { bindings } = secretStub(value);
		for (const header of ["Bearer x", "x", "Bearer null", "Bearer undefined", "Bearer Bearer"]) {
			await expectError(await call("/rest/Item", {}, { Authorization: header }, bindings), 500, "Server misconfigured");
		}
	});

	it("returns a JSON 500 when the Secrets Store fails", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const bindings = {
			DB: env.DB,
			SECRET: { get: async () => { throw new Error("store exploded: internal detail"); } },
		};
		const body = await expectError(await call("/rest/Item", {}, undefined, bindings), 500, "Internal server error");
		expect(JSON.stringify(body)).not.toContain("internal detail");
		expect(logged).toHaveBeenCalled();
	});
});

describe("unknown routes", () => {
	it("return a JSON 404 with the shared error shape", async () => {
		await expectError(await call("/nope", {}, {}), 404, "Not found");
		await expectError(await call("/", { method: "DELETE" }, {}), 404, "Not found");
		await expectError(await call("/query", { method: "GET" }), 404, "Not found");
		await expectError(await call("/REST/Item"), 404, "Not found");
	});
});
