import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { OptionsRepository, PluginManager, PluginStorageRepository, type Database } from "emdash";
import { createDialect } from "emdash/db/sqlite";
import { createMigrationExecutor } from "emdash/db/sqlite-migrations";
import { getCoreMigrationIdentity } from "emdash/migrations";
import { createPlugin, type MessageDoc } from "../../src/index";

/** Native plugin integration harness: real EmDash migrations, SQL and route dispatch. */
export async function createNativeHost(pluginOptions: Parameters<typeof createPlugin>[0] = {}) {
	const directory = await mkdtemp(join(tmpdir(), "emdash-inbox-test-"));
	const url = join(directory, "data.db");
	const executor = await createMigrationExecutor({ url }, { projectRoot: directory, env: {} });
	const identity = await getCoreMigrationIdentity();
	await executor.execute({
		action: "apply", i18n: null,
		artifact: { emdashVersion: identity.emdashVersion, migrationSetFingerprint: identity.fingerprint },
	});
	await executor.dispose?.();
	const db = new Kysely<Database>({ dialect: createDialect({ url }) });
	const plugin = createPlugin(pluginOptions);
	const manager = new PluginManager({ db });
	manager.register(plugin);
	await manager.activate(plugin.id);
	const options = new OptionsRepository(db);
	await options.set("plugin:emdash-inbox:settings:senderAddress", "owner@example.com");
	await options.set("plugin:emdash-inbox:settings:inboundSecret", "test-only-inbound-secret");
	const messages = new PluginStorageRepository<MessageDoc>(db, plugin.id, "messages", plugin.storage.messages.indexes);
	return {
		db, manager, plugin, messages,
		async request(route: string, body: unknown, headers: Record<string, string> = {}) {
			return manager.invokeRoute(plugin.id, route, {
				body,
				request: new Request(`https://site.example/_emdash/api/plugins/${plugin.id}/${route}`, {
					method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
				}),
			});
		},
		async close() { await db.destroy(); await rm(directory, { recursive: true, force: true }); },
	};
}
