import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (via Miniflare) against a LOCAL, in-memory D1
// database and a LOCAL secrets store. Nothing here talks to Cloudflare.
export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			// Relative to the project root (where `npm test` is run)
			const migrations = await readD1Migrations("migrations");
			// SRD data files (seed/srd/*.sql), split into statements the same way
			const srdSeeds = await readD1Migrations("seed/srd");
			return {
				wrangler: { configPath: "./wrangler.jsonc" },
				// Never proxy bindings to the real Cloudflare account
				remoteBindings: false,
				miniflare: {
					bindings: { TEST_MIGRATIONS: migrations, TEST_SRD_SEEDS: srdSeeds },
				},
			};
		}),
	],
	test: {
		setupFiles: ["./test/setup.ts"],
	},
});
