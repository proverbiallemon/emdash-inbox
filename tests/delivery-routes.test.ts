// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginStorageRepository } from "emdash";
import type { DeliveryAttempt, DeliveryResult } from "../src/lib/deliveryJournal";
import { createNativeHost } from "./helpers/nativeHost";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: { EMAIL: transport } }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

describe("durable delivery through native SQLite routes", () => {
	let host: Awaited<ReturnType<typeof createNativeHost>>;
	let deliveries: PluginStorageRepository<DeliveryAttempt>;
	beforeEach(async () => {
		transport.send.mockReset().mockResolvedValue({ messageId: "<route-delivery@example.com>" });
		host = await createNativeHost();
		deliveries = new PluginStorageRepository(host.db, host.plugin.id, "deliveries", ["state", "messageId"]);
	});
	afterEach(async () => { vi.restoreAllMocks(); await host?.close(); });

	async function savedDraft() {
		const response = await host.request("messages/draft-save", {
			to: "reader@example.com", cc: "copy@example.com", bcc: "hidden@example.com",
			subject: "Durable draft", text: "Private message body",
		});
		expect(response.success, JSON.stringify(response)).toBe(true);
		return (response.data as { draftId: string }).draftId;
	}

	it.each(["messages/draft-send", "mcp/send_draft"])("replays a sent draft via %s without needing a current draft or sending again", async (route) => {
		const draftId = await savedDraft();
		const input = { draftId, requestId: "draft-stable-key", edits: { text: "Final private edits" } };
		const first = await host.request(route, input);
		expect(first.success, JSON.stringify(first)).toBe(true);
		expect(first.data).toMatchObject({ id: draftId, deliveryStatus: "sent", attemptId: expect.any(String) });
		expect(await host.messages.get(draftId)).toMatchObject({ status: "done", bodyText: "Final private edits" });
		const replay = await host.request(route, input);
		expect(replay.success, JSON.stringify(replay)).toBe(true);
		expect(replay.data).toEqual(first.data);
		const mismatch = await host.request(route, { ...input, edits: { text: "Different payload" } });
		expect(mismatch.success).toBe(false);
		expect(mismatch.error?.message).toMatch(/different payload/i);
		expect(transport.send).toHaveBeenCalledOnce();
		expect((await deliveries.query({})).items).toHaveLength(1);
		expect((await host.messages.query({})).items).toHaveLength(1);
	});

	it("delivers formatted signatures with inline logos while retaining the original draft and replay key", async () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
		const html = `<p>Hello</p><p><span style="font-family:Georgia;color:#245be0">Alex</span><img src="data:image/png;base64,${png}" alt="Studio" width="160"></p>`;
		const saved = await host.request("messages/draft-save", { to: "reader@example.com", subject: "Rich signature", text: "Hello\nAlex", html });
		expect(saved.success, JSON.stringify(saved)).toBe(true);
		const draftId = (saved.data as { draftId: string }).draftId;
		expect(await host.messages.get(draftId)).toMatchObject({ bodyHtml: html, status: "draft" });
		const input = { draftId, requestId: "inline-logo-send" };
		const sent = await host.request("messages/draft-send", input);
		expect(sent.success, JSON.stringify(sent)).toBe(true);
		expect(sent.data).toMatchObject({ deliveryStatus: "sent" });
		const payload = transport.send.mock.calls[0][0];
		expect(payload.attachments).toHaveLength(1);
		const logo = payload.attachments[0];
		expect(logo).toMatchObject({ disposition: "inline", type: "image/png", filename: "signature-1.png" });
		expect(Buffer.from(logo.content).toString("base64")).toBe(png);
		expect(payload.html).toContain(`src="cid:${logo.contentId}"`);
		expect(payload.html).toContain('style="font-family:Georgia;color:#245be0"');
		expect(payload.html).not.toContain("data:image");
		expect(await host.messages.get(draftId)).toMatchObject({ bodyHtml: html, status: "done" });
		expect((await host.request("messages/draft-send", input)).data).toEqual(sent.data);
		expect(transport.send).toHaveBeenCalledOnce();
	});

	it("keeps unknown outcomes locked and never retries until an acknowledged restore and a new request", async () => {
		const draftId = await savedDraft();
		const input = { draftId, requestId: "unknown-attempt", edits: { text: "Latest unsaved edit" } };
		transport.send.mockRejectedValueOnce(new Error("Socket closed after submitting private message"));
		const uncertain = await host.request("messages/draft-send", input);
		expect(uncertain.success, JSON.stringify(uncertain)).toBe(true);
		const result = uncertain.data as DeliveryResult;
		expect(result).toMatchObject({ id: null, deliveryStatus: "uncertain", error: "delivery_outcome_unknown" });
		expect(await host.messages.get(draftId)).toMatchObject({ status: "outbox", bodyText: "Latest unsaved edit" });
		for (const [route, body] of [
			["messages/draft-save", { draftId, text: "Must remain locked" }],
			["messages/draft-discard", { draftId }],
			["messages/draft-send", { draftId, requestId: "unsafe-new-key" }],
		] as const) expect((await host.request(route, body)).success).toBe(false);
		expect((await host.request("messages/draft-send", input)).data).toEqual(result);
		expect((await host.request("deliveries/reconcile", {})).success).toBe(true);
		expect(transport.send).toHaveBeenCalledOnce();
		const denied = await host.request("deliveries/resolve", { attemptId: result.attemptId, resolution: "restore" });
		expect(denied.success).toBe(false);
		expect(denied.error?.message).toMatch(/acknowledg|duplicate/i);
		expect(await host.messages.get(draftId)).toMatchObject({ status: "outbox" });
		const restore = { attemptId: result.attemptId, resolution: "restore", confirmDuplicateRisk: true };
		for (let i = 0; i < 2; i++) {
			const restored = await host.request("deliveries/resolve", restore);
			expect(restored.success, JSON.stringify(restored)).toBe(true);
			expect(restored.data).toEqual({ ok: true, draftId });
		}
		expect(await host.messages.get(draftId)).toMatchObject({ status: "draft", bodyText: "Latest unsaved edit" });
		expect(await deliveries.get(result.attemptId)).toMatchObject({ state: "restored", resolution: { type: "restore", duplicateRiskAcknowledged: true } });
		expect((await host.request("messages/draft-send", input)).data).toMatchObject({ attemptId: result.attemptId, deliveryStatus: "failed" });
		expect(transport.send).toHaveBeenCalledOnce();
		const intentionalRetry = await host.request("messages/draft-send", { ...input, requestId: "intentional-second-attempt" });
		expect(intentionalRetry.success, JSON.stringify(intentionalRetry)).toBe(true);
		expect(intentionalRetry.data).toMatchObject({ id: draftId, deliveryStatus: "sent" });
		expect(transport.send).toHaveBeenCalledTimes(2);
	});

	it("returns a failed attempt for a definitive rejection and reserves its request key", async () => {
		const draftId = await savedDraft();
		const input = { draftId, requestId: "definitive-rejection", edits: { subject: "Final subject" } };
		transport.send.mockRejectedValueOnce(Object.assign(new Error("Provider rejected input"), { code: "E_VALIDATION_ERROR" }));
		const failed = await host.request("messages/draft-send", input);
		expect(failed.success).toBe(true);
		expect(failed.data).toMatchObject({ deliveryStatus: "failed", draftId, error: "E_VALIDATION_ERROR" });
		expect(await host.messages.get(draftId)).toMatchObject({ status: "draft", subject: "Final subject" });
		expect((await host.request("messages/draft-send", input)).data).toEqual(failed.data);
		expect(transport.send).toHaveBeenCalledOnce();
	});

	it("does not recreate a discarded failure draft during cron or reconciliation", async () => {
		transport.send.mockRejectedValueOnce(Object.assign(new Error("Provider rejected input"), { code: "E_VALIDATION_ERROR" }));
		const input = { to: "reader@example.com", subject: "Discarded failure", text: "Do not resurrect", requestId: "discard-failed-compose" };
		const failed = await host.request("messages/compose", input);
		expect(failed.success).toBe(true);
		const result = failed.data as DeliveryResult;
		expect(result).toMatchObject({ deliveryStatus: "failed", draftId: expect.any(String) });
		expect(await host.messages.get(result.draftId!)).toMatchObject({ status: "draft" });
		expect((await host.request("messages/draft-discard", { draftId: result.draftId })).success).toBe(true);
		await host.manager.invokeCronHook(host.plugin.id, { name: "wake-snoozed-messages", scheduledAt: new Date().toISOString() });
		expect((await host.request("deliveries/reconcile", {})).success).toBe(true);
		expect(await host.messages.get(result.draftId!)).toBeNull();
		expect((await host.request("messages/compose", input)).data).toMatchObject({ attemptId: result.attemptId, deliveryStatus: "failed" });
		expect(transport.send).toHaveBeenCalledOnce();
	});

	it("replays an in-flight compose key without acquiring another transport permit", async () => {
		const started = deferred<void>();
		const finish = deferred<{ messageId: string }>();
		transport.send.mockImplementationOnce(async () => { started.resolve(); return finish.promise; });
		const input = { requestId: "compose-key", to: "reader@example.com", subject: "One delivery", text: "Once" };
		const first = host.request("messages/compose", input);
		await started.promise;
		try {
			const replay = await host.request("messages/compose", input);
			expect(replay.success, JSON.stringify(replay)).toBe(true);
			expect(replay.data).toMatchObject({ deliveryStatus: "pending", attemptId: expect.any(String) });
			const mismatch = await host.request("messages/compose", { ...input, text: "Changed" });
			expect(mismatch.success).toBe(false);
			expect(transport.send).toHaveBeenCalledOnce();
			expect((await host.messages.query({ where: { status: "outbox" } })).items).toHaveLength(1);
		} finally { finish.resolve({ messageId: "<one-compose@example.com>" }); }
		const sent = await first;
		expect(sent.data).toMatchObject({ deliveryStatus: "sent" });
		expect((await host.request("messages/compose", input)).data).toEqual(sent.data);
		expect(transport.send).toHaveBeenCalledOnce();
	});

	it("recovers a persisted acceptance after mailbox projection fails without contacting transport", async () => {
		const draftId = await savedDraft();
		const write = PluginStorageRepository.prototype.compareAndSet;
		const fault = vi.spyOn(PluginStorageRepository.prototype, "compareAndSet").mockImplementation(async function (
			this: PluginStorageRepository, ...args: Parameters<typeof write>
		) {
			if (args[0] === draftId && (args[2] as any).status === "done") throw new Error("Mailbox temporarily unavailable");
			return write.apply(this, args);
		});
		const input = { draftId, requestId: "accepted-needs-projection" };
		const pending = await host.request("messages/draft-send", input);
		expect(pending.success, JSON.stringify(pending)).toBe(true);
		const result = pending.data as DeliveryResult;
		expect(result).toMatchObject({ deliveryStatus: "pending" });
		expect(await deliveries.get(result.attemptId)).toMatchObject({ state: "accepted", receipt: { messageId: "<route-delivery@example.com>" } });
		expect(await host.messages.get(draftId)).toMatchObject({ status: "outbox" });
		expect((await host.request("messages/draft-send", input)).data).toEqual(result);
		fault.mockRestore();
		const recovered = await host.request("deliveries/reconcile", {});
		expect(recovered.success, JSON.stringify(recovered)).toBe(true);
		expect(recovered.data).toMatchObject({ recovered: 1 });
		expect(await host.messages.get(draftId)).toMatchObject({ status: "done", messageId: "<route-delivery@example.com>" });
		expect(await deliveries.get(result.attemptId)).toMatchObject({ state: "sent" });
		expect((await host.request("messages/draft-send", input)).data).toMatchObject({ id: draftId, attemptId: result.attemptId, deliveryStatus: "sent" });
		expect((await host.request("deliveries/reconcile", {})).data).toMatchObject({ recovered: 0 });
		expect(transport.send).toHaveBeenCalledOnce();
	});

	it("lists only public delivery summaries over both HTTP and MCP routes", async () => {
		const draftId = await savedDraft();
		transport.send.mockRejectedValueOnce(new Error("Timeout includes private provider response body"));
		await host.request("messages/draft-send", { draftId, requestId: "private-summary" });
		for (const route of ["deliveries/list", "mcp/list_deliveries"]) {
			const listed = await host.request(route, { limit: 1 });
			expect(listed.success, JSON.stringify(listed)).toBe(true);
			const page = listed.data as { items: Record<string, unknown>[]; hasMore: boolean };
			expect(page.items).toHaveLength(1);
			expect(page.items[0]).toMatchObject({ messageId: draftId, state: "uncertain", subject: "Durable draft", to: ["reader@example.com"], canResolve: true });
			expect(Object.keys(page.items[0]).sort()).toEqual(["attemptId", "messageId", "state", "subject", "to", "createdAt", "updatedAt", "error", "canResolve"].sort());
			const serialized = JSON.stringify(page);
			for (const privateValue of ["hidden@example.com", "copy@example.com", "Private message body", "private provider response", "snapshot", "bodyHtml", "objectKey", "fingerprint"]) {
				expect(serialized).not.toContain(privateValue);
			}
		}
	});

	it("allows an operator to confirm an uncertain send through MCP without sending again", async () => {
		const draftId = await savedDraft();
		transport.send.mockRejectedValueOnce(new Error("Connection lost"));
		const uncertain = await host.request("mcp/send_draft", { draftId, requestId: "operator-confirmation" });
		const attemptId = (uncertain.data as DeliveryResult).attemptId;
		const input = { attemptId, resolution: "sent", providerMessageId: "<verified-provider@example.com>" };
		for (let i = 0; i < 2; i++) {
			const confirmed = await host.request("mcp/resolve_delivery", input);
			expect(confirmed.success, JSON.stringify(confirmed)).toBe(true);
			expect(confirmed.data).toMatchObject({ ok: true, id: draftId, threadId: "<verified-provider@example.com>" });
		}
		expect(await host.messages.get(draftId)).toMatchObject({ status: "done", messageId: "<verified-provider@example.com>" });
		expect(transport.send).toHaveBeenCalledOnce();
	});

	it("replays a reply against its original payload even after the thread gains a newer message", async () => {
		const inbound = (id: string, parent?: string) => host.request("inbound", {
			rawMime: ["From: reader@example.com", "To: owner@example.com", "Subject: Conversation", `Message-ID: <${id}@example.com>`, ...(parent ? [`In-Reply-To: <${parent}@example.com>`] : []), "", "Incoming message"].join("\r\n"),
		}, { "X-Inbound-Secret": "test-only-inbound-secret" });
		expect((await inbound("parent")).success).toBe(true);
		const input = { threadId: "<parent@example.com>", text: "Original reply", requestId: "reply-key" };
		const first = await host.request("mcp/reply_to_thread", input);
		expect(first.success, JSON.stringify(first)).toBe(true);
		expect((await inbound("newer", "parent")).success).toBe(true);
		const replay = await host.request("mcp/reply_to_thread", input);
		expect(replay.success, JSON.stringify(replay)).toBe(true);
		expect(replay.data).toEqual(first.data);
		expect(transport.send).toHaveBeenCalledOnce();
		expect(transport.send.mock.calls[0][0].headers["In-Reply-To"]).toBe("<parent@example.com>");
	});
});
