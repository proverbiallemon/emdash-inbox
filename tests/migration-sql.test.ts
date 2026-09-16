// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OptionsRepository, PluginStorageRepository } from "emdash";
import { createNativeHost } from "./helpers/nativeHost";
import { MAILBOX_MIGRATION_KEY } from "../src/lib/mailboxStore";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: { EMAIL: transport } }));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => { resolve = res; });
	return { promise, resolve };
}

describe("native migration and draft contention", () => {
	let host: Awaited<ReturnType<typeof createNativeHost>>;

	beforeEach(async () => {
		transport.send.mockReset().mockResolvedValue({ messageId: "<migration-send@cloudflare.example>" });
		host = await createNativeHost();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await host?.close();
	});

	it.each(["discard_draft", "send_draft"])(
		"a delayed list migration cannot resurrect a draft after %s",
		async (operation) => {
			const saved = await host.request("mcp/save_draft", {
				to: "reader@example.com", subject: "Fresh draft", text: "Ready to send",
			});
			expect(saved.success, JSON.stringify(saved)).toBe(true);
			const draftId = (saved.data as { draftId: string }).draftId;
			expect((await host.messages.get(draftId))?.threadId).toBeNull();
			// Simulate upgrading a database whose historical scan is unfinished.
			await new OptionsRepository(host.db).delete(`plugin:emdash-inbox:${MAILBOX_MIGRATION_KEY}`);

			const captured = deferred();
			const resume = deferred();
			let held = false;
			const query = PluginStorageRepository.prototype.query;
			// Hold the actual migration page containing the draft after SQL reads,
			// while a concurrent route claims/removes that same source row.
			vi.spyOn(PluginStorageRepository.prototype, "query").mockImplementation(async function (
				this: PluginStorageRepository,
				options,
			) {
				const result = await query.call(this, options);
				if (!held && !options?.where && result.items.some((row) => row.id === draftId)) {
					held = true;
					captured.resolve();
					await resume.promise;
				}
				return result;
			});
			const listing = host.request("mcp/list_drafts", {});
			await captured.promise;
			try {
				const removed = await host.request(`mcp/${operation}`, { draftId });
				expect(removed.success, JSON.stringify(removed)).toBe(true);
				if (operation === "discard_draft") expect(await host.messages.get(draftId)).toBeNull();
				else expect(await host.messages.get(draftId)).toMatchObject({ status: "done", messageId: "<migration-send@cloudflare.example>" });
			} finally {
				resume.resolve();
			}
			const listed = await listing;

			expect(listed.success, JSON.stringify(listed)).toBe(true);
			expect(listed.data).toEqual([]);
			if (operation === "discard_draft") expect(await host.messages.get(draftId)).toBeNull();
				else expect(await host.messages.get(draftId)).toMatchObject({ status: "done", messageId: "<migration-send@cloudflare.example>" });
			const sent = await host.messages.query({ where: { status: "done" } });
			expect(sent.items).toHaveLength(operation === "send_draft" ? 1 : 0);
		},
	);
});
