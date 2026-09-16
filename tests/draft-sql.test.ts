// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginStorageRepository } from "emdash";
import { createNativeHost } from "./helpers/nativeHost";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: { EMAIL: transport } }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("draft operations with EmDash SQLite storage", () => {
	let host: Awaited<ReturnType<typeof createNativeHost>>;

	beforeEach(async () => {
		transport.send.mockReset().mockResolvedValue({ messageId: "<draft-delivery@cloudflare.example>" });
		host = await createNativeHost();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await host?.close();
	});

	async function saveDraft() {
		const saved = await host.request("mcp/save_draft", {
			to: "reader@example.com",
			subject: "Draft subject",
			text: "Original text",
		});
		expect(saved.success, JSON.stringify(saved)).toBe(true);
		return (saved.data as { draftId: string }).draftId;
	}

	function pauseNextDraftRead(draftId: string) {
		const reached = deferred<void>();
		const release = deferred<void>();
		const read = PluginStorageRepository.prototype.getVersioned;
		let paused = false;
		vi.spyOn(PluginStorageRepository.prototype, "getVersioned").mockImplementation(async function (
			this: PluginStorageRepository, id: string,
		) {
			const current = await read.call(this, id);
			if (id === draftId && !paused) {
				paused = true; reached.resolve(); await release.promise;
			}
			return current;
		});
		return { reached: reached.promise, release: release.resolve };
	}

	it("saves a new revision and sends text edits with consistent HTML through native MCP", async () => {
		const draftId = await saveDraft();
		// Rich HTML is saved by the admin composer; MCP draft saves are text-only.
		const rich = await host.request("messages/draft-save", { draftId, html: "<p><strong>Original text</strong></p>" });
		expect(rich.success, JSON.stringify(rich)).toBe(true);
		const original = await host.messages.getVersioned(draftId);
		expect(original?.value.bodyHtml).toContain("<strong>Original text</strong>");
		const saved = await host.request("mcp/save_draft", {
			draftId,
			text: "Updated <body>\nNext line",
		});
		expect(saved.success, JSON.stringify(saved)).toBe(true);
		const edited = await host.messages.getVersioned(draftId);
		expect(edited?.revision).not.toBe(original?.revision);
		expect(edited?.value.bodyText).toBe("Updated <body>\nNext line");

		const sent = await host.request("mcp/send_draft", { draftId });

		expect(sent.success, JSON.stringify(sent)).toBe(true);
		expect(sent.data).toMatchObject({ id: draftId, deliveryStatus: "sent", attemptId: expect.any(String) });
		expect(await host.messages.get(draftId)).toMatchObject({ status: "done" });
		expect(transport.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			to: ["reader@example.com"],
			text: "Updated <body>\nNext line",
			html: "<p>Updated &lt;body&gt;<br>Next line</p>",
		}));
		const sentRow = await host.messages.get((sent.data as { id: string }).id);
		expect(sentRow).toMatchObject({
			status: "done",
			bodyText: "Updated <body>\nNext line",
			bodyHtml: "<p>Updated &lt;body&gt;<br>Next line</p>",
			messageId: "<draft-delivery@cloudflare.example>",
		});
	});

	it("only delivers once when native send requests read the same SQL revision", async () => {
		const draftId = await saveDraft();
		const snapshotsReady = deferred<void>();
		const releaseReads = deferred<void>();
		const deliveryStarted = deferred<void>();
		const finishDelivery = deferred<{ messageId: string }>();
		const revisions: string[] = [];
		const getVersioned = PluginStorageRepository.prototype.getVersioned;
		// Pause only after real SQL reads. Conditional claims and all writes
		// still run through EmDash's actual repository and SQLite adapter.
		vi.spyOn(PluginStorageRepository.prototype, "getVersioned").mockImplementation(async function (
			this: PluginStorageRepository,
			id: string,
		) {
			const snapshot = await getVersioned.call(this, id);
			if (id === draftId && snapshot && revisions.length < 2) {
				revisions.push(snapshot.revision);
				if (revisions.length === 2) snapshotsReady.resolve();
				await releaseReads.promise;
			}
			return snapshot;
		});
		transport.send.mockImplementation(async () => {
			deliveryStarted.resolve();
			return finishDelivery.promise;
		});
		const results = Promise.all([
			host.request("mcp/send_draft", { draftId }),
			host.request("mcp/send_draft", { draftId }),
		]);

		await snapshotsReady.promise;
		expect(revisions[0]).toBe(revisions[1]);
		releaseReads.resolve();
		await deliveryStarted.promise;
		try {
			expect(await host.messages.get(draftId)).toMatchObject({ status: "outbox", deliveryAttemptId: expect.any(String) });
		} finally {
			finishDelivery.resolve({ messageId: "<draft-delivery@cloudflare.example>" });
		}
		const outcomes = await results;

		expect(outcomes.filter((outcome) => outcome.success)).toHaveLength(1);
		expect(outcomes.filter((outcome) => !outcome.success)).toHaveLength(1);
		expect(transport.send).toHaveBeenCalledOnce();
		const stored = await host.messages.query({ limit: 100 });
		expect(stored.items).toHaveLength(1);
		expect(stored.items[0].data).toMatchObject({
			status: "done", messageId: "<draft-delivery@cloudflare.example>",
		});
	});

	it("restores the latest send edits as a new SQL revision after delivery rejects", async () => {
		const draftId = await saveDraft();
		const original = await host.messages.getVersioned(draftId);
		transport.send.mockRejectedValueOnce(Object.assign(new Error("Provider rejected delivery"), { code: "E_VALIDATION_ERROR" }));

		const failed = await host.request("mcp/send_draft", {
			draftId,
			edits: {
				to: ["new@example.com", "other@example.com"],
				cc: "copy@example.com",
				bcc: "hidden@example.com",
				subject: "Latest subject",
				text: "Latest & final text",
			},
		});

		expect(failed.success, JSON.stringify(failed)).toBe(true);
		expect(failed.data).toMatchObject({ deliveryStatus: "failed", draftId, error: "E_VALIDATION_ERROR" });
		const restored = await host.messages.getVersioned(draftId);
		expect(restored?.revision).not.toBe(original?.revision);
		expect(restored?.value).toMatchObject({
			status: "draft",
			to: "new@example.com",
			toAll: ["new@example.com", "other@example.com"],
			cc: ["copy@example.com"],
			bcc: ["hidden@example.com"],
			subject: "Latest subject",
			bodyText: "Latest & final text",
			bodyHtml: "<p>Latest &amp; final text</p>",
		});
		expect((await host.messages.query({ where: { status: "done" } })).items).toHaveLength(0);

		const retry = await host.request("mcp/send_draft", { draftId });
		expect(retry.success, JSON.stringify(retry)).toBe(true);
		expect(retry.data).toMatchObject({ id: draftId, deliveryStatus: "sent" });
		expect(await host.messages.get(draftId)).toMatchObject({ status: "done" });
		expect(transport.send).toHaveBeenLastCalledWith(expect.objectContaining({
			to: ["new@example.com", "other@example.com"],
			subject: "Latest subject",
			text: "Latest & final text",
			html: "<p>Latest &amp; final text</p>",
		}));
	});

	it("does not overwrite a replacement SQL row while restoring a rejected send", async () => {
		const draftId = await saveDraft();
		const original = (await host.messages.get(draftId))!;
		const deliveryStarted = deferred<void>();
		const delivery = deferred<{ messageId: string }>();
		transport.send.mockImplementation(async () => {
			deliveryStarted.resolve();
			return delivery.promise;
		});
		const sending = host.request("mcp/send_draft", { draftId });

		await deliveryStarted.promise;
		const replacement = { ...original, subject: "Replacement draft" };
		const claimed = await host.messages.getVersioned(draftId);
		expect(claimed?.value.status).toBe("outbox");
		const created = await host.messages.compareAndSet(draftId, claimed!.revision, replacement);
		expect(created.applied).toBe(true);
		delivery.reject(Object.assign(new Error("Provider rejected delivery"), { code: "E_VALIDATION_ERROR" }));
		const failed = await sending;
		expect(failed.success).toBe(true);
		expect(failed.data).toMatchObject({ deliveryStatus: "failed" });

		expect(await host.messages.get(draftId)).toEqual(replacement);
		expect((await host.messages.query({ where: { status: "done" } })).items).toHaveLength(0);
	});

	it("does not send a stale revision after a concurrent save", async () => {
		const draftId = await saveDraft();
		const paused = pauseNextDraftRead(draftId);
		const sending = host.request("mcp/send_draft", { draftId });
		await paused.reached;
		const saved = await host.request("messages/draft-save", { draftId, text: "Newer draft revision" });
		expect(saved.success).toBe(true);
		paused.release();
		expect((await sending).success).toBe(false);
		expect(transport.send).not.toHaveBeenCalled();
		expect(await host.messages.get(draftId)).toMatchObject({ status: "draft", bodyText: "Newer draft revision" });
	});

	it.each(["messages/draft-save", "messages/draft-discard"])("a stale %s cannot rewrite or remove the sent row", async (route) => {
		const draftId = await saveDraft();
		const paused = pauseNextDraftRead(draftId);
		const stale = host.request(route, { draftId, text: "Stale edit" });
		await paused.reached;
		const sent = await host.request("messages/draft-send", { draftId });
		expect(sent.success).toBe(true);
		paused.release();
		expect((await stale).success).toBe(false);
		expect(transport.send).toHaveBeenCalledOnce();
		expect(await host.messages.get(draftId)).toMatchObject({ status: "done", bodyText: "Original text" });
	});
});
