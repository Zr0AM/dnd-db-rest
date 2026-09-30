import { adminSecretsStore, applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Apply the real migrations (migrations/*.sql) to the local test database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Put a throwaway value in the LOCAL secrets store. The real secret is never read.
await adminSecretsStore(env.SECRET).create("test-secret-not-real");
