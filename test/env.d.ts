// (path reference because tsconfig uses node-style module resolution, which ignores package "exports")
/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import type { D1Migration } from "cloudflare:test";

declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
			TEST_SRD_SEEDS: D1Migration[];
		}
	}
}
