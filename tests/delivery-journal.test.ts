// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OptionsRepository, PluginStorageRepository } from "emdash";
import type { MessageDoc } from "../src/index";
import { type DeliveryAttempt, findDeliveryRequest, listDeliveries, markDeliveryDraftDiscarded, projectDeliveryMessage, reconcileDeliveries, resolveDelivery, runDelivery } from "../src/lib/deliveryJournal";
import { createNativeHost } from "./helpers/nativeHost";

vi.mock("cloudflare:workers", () => ({ env: { EMAIL: { send: vi.fn() } } }));

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

describe("durable delivery journal with native SQLite CAS", () => {
	let host: Awaited<ReturnType<typeof createNativeHost>>;
	let ctx: any;
	let deliveries: PluginStorageRepository<DeliveryAttempt>;
	let transport: ReturnType<typeof vi.fn>;
	const snapshot = (): MessageDoc => ({
		messageId: "<draft-test@local>", direction: "outbound", from: "owner@example.com",
		to: "reader@example.com", toAll: ["reader@example.com"], cc: [], bcc: ["private@example.com"],
		subject: "Durable mail", bodyText: "Private body", bodyHtml: "<p>Private body</p>", bodyRaw: "private raw headers",
		threadId: null, receivedAt: "2026-09-16T00:00:00.000Z", source: "test", status: "draft",
		pinned: false, read: true, bundleId: null, sortAt: "2026-09-16T00:00:00.000Z", snoozeUntil: null, inReplyTo: null,
		attachments: [{ id: "a1", filename: "private.txt", contentType: "text/plain", size: 4, objectKey: "secret/object/key" }],
	} as MessageDoc);
	const projectSent = async (context: any, attempt: DeliveryAttempt) => projectDeliveryMessage(context, attempt, {
		...attempt.snapshot, status: "done", messageId: attempt.receipt?.messageId ?? `<sent-${attempt.messageId}@local>`,
		threadId: attempt.snapshot.threadId ?? attempt.receipt?.messageId ?? `<sent-${attempt.messageId}@local>`,
	});
	const send = (input: Partial<Parameters<typeof runDelivery>[1]> = {}, project = projectSent) => runDelivery(ctx, { snapshot: snapshot(), ...input }, { transport, projectSent: project });
	const recover = (project = projectSent, limit = 30) => reconcileDeliveries(ctx, project, { now: Date.now() + 600_000, limit });

	beforeEach(async () => {
		host = await createNativeHost();
		deliveries = new PluginStorageRepository(host.db, host.plugin.id, "deliveries", ["state", "messageId"]);
		const messages = new PluginStorageRepository(host.db, host.plugin.id, "messages", [...host.plugin.storage.messages.indexes, "deliveryAttemptId"]);
		ctx = { storage: { messages, deliveries }, kv: new OptionsRepository(host.db) };
		transport = vi.fn().mockResolvedValue({ messageId: "<accepted@provider.example>" });
	});
	afterEach(async () => { vi.restoreAllMocks(); await host?.close(); });

	it("persists the entire same-ID outbox before transport and its receipt before projection", async () => {
		await ctx.storage.messages.put("draft-1", snapshot());
		const draft = await ctx.storage.messages.getVersioned("draft-1");
		transport.mockImplementation(async () => {
			const row = await ctx.storage.messages.get("draft-1");
			expect(row).toMatchObject({ status: "outbox", bodyText: "Edited at send", attachments: snapshot().attachments });
			expect((await deliveries.get(row.deliveryAttemptId))?.state).toBe("sending");
			return { messageId: "<accepted@provider.example>" };
		});
		const projector = vi.fn(async (context, attempt) => {
			expect(await deliveries.get(attempt.attemptId)).toMatchObject({ state: "accepted", receipt: { messageId: "<accepted@provider.example>" } });
			return projectSent(context, attempt);
		});
		const outcome = await send({ snapshot: { ...snapshot(), bodyText: "Edited at send" }, draftClaim: { id: "draft-1", revision: draft.revision } }, projector);
		expect(outcome).toMatchObject({ id: "draft-1", deliveryStatus: "sent" });
		expect(await ctx.storage.messages.get("draft-1")).toMatchObject({ status: "done", indexDirty: true });
		expect(projector).toHaveBeenCalledOnce();
	});

	it("concurrent sends can only consume one draft revision", async () => {
		await ctx.storage.messages.put("draft-1", snapshot());
		const draft = await ctx.storage.messages.getVersioned("draft-1");
		const outcomes = await Promise.allSettled([send({ messageId: "draft-1", expectedRevision: draft.revision }), send({ messageId: "draft-1", expectedRevision: draft.revision })]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(transport).toHaveBeenCalledOnce();
		expect((await ctx.storage.messages.query({ limit: 100 })).items).toHaveLength(1);
	});

	it.each(["claim", "journal", "sending"])("does not send after a committed %s write loses its acknowledgement", async (phase) => {
		const collection = phase === "claim" ? ctx.storage.messages : deliveries;
		const cas = collection.compareAndSet.bind(collection);
		let injected = false;
		vi.spyOn(collection, "compareAndSet").mockImplementation(async (...args: any[]) => {
			const result = await cas(...args);
			if (!injected && (phase !== "sending" || args[2].state === "sending")) { injected = true; throw new Error("commit acknowledgement lost"); }
			return result;
		});
		const outcome = await send({ requestId: `ack-${phase}`, requestPayload: { text: "same" } });
		expect(outcome.deliveryStatus).toBe("pending");
		expect(transport).not.toHaveBeenCalled();
		await recover();
		await recover();
		const attempt = await deliveries.get(outcome.attemptId);
		expect(attempt?.state).toBe(phase === "sending" ? "uncertain" : "restored");
		expect((await ctx.storage.messages.get(attempt!.messageId)).status).toBe(phase === "sending" ? "outbox" : "draft");
		expect(transport).not.toHaveBeenCalled();
	});

	it("a failed initial reservation leaves the draft unchanged and creates no phantom pending delivery", async () => {
		await ctx.storage.messages.put("draft-1", snapshot());
		const before = await ctx.storage.messages.getVersioned("draft-1");
		vi.spyOn(deliveries, "compareAndSet").mockRejectedValueOnce(new Error("database write failed before commit"));
		await expect(send({ messageId: "draft-1", expectedRevision: before.revision })).rejects.toThrow("before commit");
		expect(await ctx.storage.messages.getVersioned("draft-1")).toEqual(before);
		expect((await listDeliveries(ctx)).items).toHaveLength(0);
		expect(transport).not.toHaveBeenCalled();
	});

	it("does not report a pending delivery when both reservation and confirmation reads fail", async () => {
		vi.spyOn(deliveries, "compareAndSet").mockRejectedValueOnce(new Error("reservation unavailable"));
		vi.spyOn(deliveries, "getVersioned").mockRejectedValueOnce(new Error("confirmation unavailable"));
		await expect(send()).rejects.toThrow("reservation unavailable");
		expect(transport).not.toHaveBeenCalled();
	});

	it("recovers final send edits from a journal whose acknowledgement was lost before draft claim", async () => {
		await ctx.storage.messages.put("draft-1", snapshot());
		const before = await ctx.storage.messages.getVersioned("draft-1");
		const cas = deliveries.compareAndSet.bind(deliveries);
		vi.spyOn(deliveries, "compareAndSet").mockImplementationOnce(async (...args) => { await cas(...args); throw new Error("journal acknowledgement lost"); });
		const outcome = await send({ snapshot: { ...snapshot(), bodyText: "Unsaved final edits", bodyHtml: "<p>Unsaved final edits</p>" }, messageId: "draft-1", expectedRevision: before.revision });
		expect(outcome.deliveryStatus).toBe("pending");
		expect(await ctx.storage.messages.getVersioned("draft-1")).toEqual(before);
		await recover();
		expect(await ctx.storage.messages.get("draft-1")).toMatchObject({ status: "draft", bodyText: "Unsaved final edits", deliveryAttemptId: outcome.attemptId });
		expect((await listDeliveries(ctx)).items[0]).toMatchObject({ draftId: "draft-1" });
		expect(transport).not.toHaveBeenCalled();
	});

	it("preserves newer draft edits if a reservation was interrupted before claim", async () => {
		await ctx.storage.messages.put("draft-1", snapshot());
		const before = await ctx.storage.messages.getVersioned("draft-1");
		const cas = deliveries.compareAndSet.bind(deliveries);
		vi.spyOn(deliveries, "compareAndSet").mockImplementationOnce(async (...args) => { await cas(...args); throw new Error("journal acknowledgement lost"); });
		await send({ snapshot: { ...snapshot(), bodyText: "Send-time edits" }, messageId: "draft-1", expectedRevision: before.revision });
		await ctx.storage.messages.compareAndSet("draft-1", before.revision, { ...before.value, bodyText: "Later user edits" });
		await recover();
		expect(await ctx.storage.messages.get("draft-1")).toMatchObject({ status: "draft", bodyText: "Later user edits" });
	});

	it("restores final edits and attachments only after a definitive rejection", async () => {
		transport.mockRejectedValue(Object.assign(new Error("not exposed"), { definitive: true, code: "invalid_recipient" }));
		const outcome = await send({ snapshot: { ...snapshot(), bodyText: "Latest edits" } });
		expect(outcome).toMatchObject({ deliveryStatus: "failed", error: "invalid_recipient" });
		expect(await ctx.storage.messages.get(outcome.draftId)).toMatchObject({ status: "draft", bodyText: "Latest edits", attachments: snapshot().attachments });
		await recover();
		expect(transport).toHaveBeenCalledOnce();
	});

	it.each([new Error("timeout with secret recipient"), { code: "internal_error" }, { code: "future_unknown_code" }])("holds ambiguous provider failure in Outbox without automatic restore", async (error) => {
		transport.mockRejectedValue(error);
		const outcome = await send();
		expect(outcome.deliveryStatus).toBe("uncertain");
		await recover();
		expect((await deliveries.get(outcome.attemptId))?.state).toBe("uncertain");
		const rows = await ctx.storage.messages.query({ where: { status: "draft" } });
		expect(rows.items).toHaveLength(0);
		expect(transport).toHaveBeenCalledOnce();
	});

	it.each([false, true])("never re-sends acceptance when receipt persistence fails (committed=%s)", async (commit) => {
		const cas = deliveries.compareAndSet.bind(deliveries);
		let injected = false;
		vi.spyOn(deliveries, "compareAndSet").mockImplementation(async (...args) => {
			if (!injected && args[2].state === "accepted") {
				injected = true;
				if (commit) await cas(...args);
				throw new Error("receipt unavailable");
			}
			return cas(...args);
		});
		const outcome = await send();
		expect(outcome.deliveryStatus).toBe("pending");
		await recover();
		expect((await deliveries.get(outcome.attemptId))?.state).toBe(commit ? "sent" : "uncertain");
		expect(transport).toHaveBeenCalledOnce();
	});

	it.each([false, true])("recovers a failed Sent projection without replacing user triage (committed=%s)", async (commit) => {
		const failingProjector = async (context: any, attempt: DeliveryAttempt) => {
			if (commit) {
				await projectSent(context, attempt);
				const current = await ctx.storage.messages.getVersioned(attempt.messageId);
				await ctx.storage.messages.compareAndSet(attempt.messageId, current.revision, { ...current.value, status: "inbox", pinned: true, read: false });
			}
			throw new Error("projection acknowledgement lost");
		};
		const outcome = await send({}, failingProjector);
		expect(outcome.deliveryStatus).toBe("pending");
		await recover();
		await recover();
		const attempt = (await deliveries.get(outcome.attemptId))!;
		expect(attempt.state).toBe("sent");
		expect(await ctx.storage.messages.get(attempt.messageId)).toMatchObject(commit ? { status: "inbox", pinned: true, read: false } : { status: "done" });
		expect(transport).toHaveBeenCalledOnce();
	});

	it("deduplicates stable retries, rejects changed payloads and sanitizes list DTOs", async () => {
		const input = { requestId: "stable-request", requestPayload: { to: "reader@example.com", text: "message" } };
		const [first, second] = await Promise.all([send(input), send(input)]);
		expect(first.attemptId).toBe(second.attemptId);
		expect(await findDeliveryRequest(ctx, input.requestId, input.requestPayload)).toMatchObject({ deliveryStatus: "sent" });
		await expect(send({ ...input, requestPayload: { text: "changed" } })).rejects.toThrow("different payload");
		expect(transport).toHaveBeenCalledOnce();
		const listed = JSON.stringify(await listDeliveries(ctx));
		for (const privateValue of ["Private body", "private raw headers", "secret/object/key", "private@example.com"]) expect(listed).not.toContain(privateValue);
	});

	it("globally fences concurrent reuse of one request key across different drafts", async () => {
		await ctx.storage.messages.put("draft-a", snapshot());
		await ctx.storage.messages.put("draft-b", snapshot());
		const a = await ctx.storage.messages.getVersioned("draft-a");
		const b = await ctx.storage.messages.getVersioned("draft-b");
		const outcomes = await Promise.allSettled([
			send({ requestId: "same-global-key", requestPayload: { draftId: "draft-a" }, messageId: "draft-a", expectedRevision: a.revision }),
			send({ requestId: "same-global-key", requestPayload: { draftId: "draft-b" }, messageId: "draft-b", expectedRevision: b.revision }),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: { message: "requestId was already used with a different payload" } });
		expect(transport).toHaveBeenCalledOnce();
		expect((await ctx.storage.messages.query({ where: { status: "draft" } })).items).toHaveLength(1);
		expect((await ctx.storage.messages.query({ where: { status: "outbox" } })).items).toHaveLength(0);
	});

	it("cancellation of an old prepared attempt fences a delayed sender before transport", async () => {
		const beforeSending = deferred(); const continueSending = deferred();
		const cas = deliveries.compareAndSet.bind(deliveries);
		vi.spyOn(deliveries, "compareAndSet").mockImplementation(async (...args) => {
			if (args[2].state === "sending") { beforeSending.resolve(); await continueSending.promise; }
			return cas(...args);
		});
		const sending = send();
		await beforeSending.promise;
		await recover();
		continueSending.resolve();
		expect((await sending).deliveryStatus).toBe("failed");
		expect(transport).not.toHaveBeenCalled();
		expect((await ctx.storage.messages.query({ where: { status: "draft" } })).items).toHaveLength(1);
	});

	it("requires explicit duplicate-risk acknowledgement and concurrent restore is idempotent", async () => {
		transport.mockRejectedValue(new Error("timeout"));
		const outcome = await send();
		await expect(resolveDelivery(ctx, projectSent, { attemptId: outcome.attemptId, resolution: "restore" })).rejects.toThrow("acknowledging");
		const input = { attemptId: outcome.attemptId, resolution: "restore" as const, confirmDuplicateRisk: true };
		const results = await Promise.all([resolveDelivery(ctx, projectSent, input), resolveDelivery(ctx, projectSent, input)]);
		expect(results[0]).toEqual(results[1]);
		expect(await ctx.storage.messages.get(results[0].draftId)).toMatchObject({ status: "draft" });
		expect(transport).toHaveBeenCalledOnce();
	});

	it("manual sent resolution is repeatable and accepts an optional real Message-ID", async () => {
		transport.mockRejectedValue(new Error("timeout"));
		const outcome = await send();
		const input = { attemptId: outcome.attemptId, resolution: "sent" as const, providerMessageId: "<confirmed@provider.example>" };
		const first = await resolveDelivery(ctx, projectSent, input);
		expect(await resolveDelivery(ctx, projectSent, input)).toEqual(first);
		expect(await ctx.storage.messages.get(first.id)).toMatchObject({ status: "done", messageId: "<confirmed@provider.example>" });
		expect(transport).toHaveBeenCalledOnce();
	});

	it("does not permit marking a definitive rejection sent and only links a current restored draft", async () => {
		transport.mockRejectedValue(Object.assign(new Error("rejected"), { definitive: true }));
		const outcome = await send();
		await expect(resolveDelivery(ctx, projectSent, { attemptId: outcome.attemptId, resolution: "sent" })).rejects.toThrow("definitively rejected");
		expect((await listDeliveries(ctx)).items[0]).toMatchObject({ draftId: outcome.draftId, canResolve: false });
		await ctx.storage.messages.delete(outcome.draftId);
		expect((await listDeliveries(ctx)).items[0]).not.toHaveProperty("draftId");
	});

	it("never resurrects a recovered direct-send draft after discard, even after a lost delete acknowledgement", async () => {
		transport.mockRejectedValue(Object.assign(new Error("rejected"), { definitive: true }));
		const outcome = await send();
		const draft = await ctx.storage.messages.getVersioned(outcome.draftId);
		await markDeliveryDraftDiscarded(ctx, outcome.attemptId, outcome.draftId!);
		const remove = ctx.storage.messages.compareAndDelete.bind(ctx.storage.messages);
		vi.spyOn(ctx.storage.messages, "compareAndDelete").mockImplementationOnce(async (...args: any[]) => { await remove(...args); throw new Error("delete acknowledgement lost"); });
		await expect(ctx.storage.messages.compareAndDelete(outcome.draftId, draft.revision)).rejects.toThrow("acknowledgement");
		await recover(); await recover();
		expect(await ctx.storage.messages.get(outcome.draftId)).toBeNull();
		expect((await listDeliveries(ctx)).items[0]).not.toHaveProperty("draftId");
	});

	it("a later send fences restoration by every older attempt when its recovered draft is discarded", async () => {
		transport.mockRejectedValue(Object.assign(new Error("rejected"), { definitive: true }));
		const first = await send();
		const draft = await ctx.storage.messages.getVersioned(first.draftId);
		const second = await send({ snapshot: draft.value, messageId: first.draftId, expectedRevision: draft.revision });
		expect(second.deliveryStatus).toBe("failed");
		expect((await deliveries.get(first.attemptId))?.restoreSuppressed).toBe(true);
		const restored = await ctx.storage.messages.getVersioned(second.draftId);
		await markDeliveryDraftDiscarded(ctx, second.attemptId, second.draftId!);
		await ctx.storage.messages.compareAndDelete(second.draftId, restored.revision);
		await recover(); await recover();
		expect(await ctx.storage.messages.get(second.draftId)).toBeNull();
	});

	it("late provider acceptance supersedes restoration of an untouched draft", async () => {
		const started = deferred(); const response = deferred<{ messageId: string }>();
		transport.mockImplementation(async () => { started.resolve(); return response.promise; });
		const sending = send({ requestId: "late", requestPayload: {} });
		await started.promise;
		await recover();
		const existing = (await findDeliveryRequest(ctx, "late", {}))!;
		const restored = await resolveDelivery(ctx, projectSent, { attemptId: existing.attemptId, resolution: "restore", confirmDuplicateRisk: true });
		expect((await ctx.storage.messages.get(restored.draftId)).status).toBe("draft");
		response.resolve({ messageId: "<late@provider.example>" });
		expect((await sending).deliveryStatus).toBe("sent");
		expect(await ctx.storage.messages.get(restored.draftId)).toMatchObject({ status: "done", messageId: "<late@provider.example>" });
	});

	it("reports known late acceptance pending if receipt persistence fails after an operator restore", async () => {
		const started = deferred(); const response = deferred<{ messageId: string }>();
		transport.mockImplementation(async () => { started.resolve(); return response.promise; });
		const sending = send({ requestId: "late-acceptance-write-fails", requestPayload: {} });
		await started.promise; await recover();
		const existing = (await findDeliveryRequest(ctx, "late-acceptance-write-fails", {}))!;
		await resolveDelivery(ctx, projectSent, { attemptId: existing.attemptId, resolution: "restore", confirmDuplicateRisk: true });
		const cas = deliveries.compareAndSet.bind(deliveries);
		vi.spyOn(deliveries, "compareAndSet").mockImplementation(async (...args) => {
			if (args[2].state === "accepted") throw new Error("accepted receipt unavailable");
			return cas(...args);
		});
		response.resolve({ messageId: "<accepted-late@provider.example>" });
		const outcome = await sending;
		expect(outcome).toMatchObject({ deliveryStatus: "pending", providerAccepted: true, id: null });
		expect(outcome).not.toHaveProperty("draftId");
	});

	it("retains a late accepted receipt without overwriting edits to a restored draft", async () => {
		const started = deferred(); const response = deferred<{ messageId: string }>();
		transport.mockImplementation(async () => { started.resolve(); return response.promise; });
		const sending = send({ requestId: "late-edited", requestPayload: {} });
		await started.promise; await recover();
		const existing = (await findDeliveryRequest(ctx, "late-edited", {}))!;
		const restored = await resolveDelivery(ctx, projectSent, { attemptId: existing.attemptId, resolution: "restore", confirmDuplicateRisk: true });
		const draft = await ctx.storage.messages.getVersioned(restored.draftId);
		await ctx.storage.messages.compareAndSet(restored.draftId, draft.revision, { ...draft.value, bodyText: "User edits after restoration" });
		response.resolve({ messageId: "<late@provider.example>" });
		expect((await sending).deliveryStatus).toBe("pending");
		await recover();
		expect(await deliveries.get(existing.attemptId)).toMatchObject({ state: "accepted", receipt: { messageId: "<late@provider.example>" }, error: expect.stringContaining("Verify the provider receipt") });
		expect(await ctx.storage.messages.get(restored.draftId)).toMatchObject({ status: "draft", bodyText: "User edits after restoration" });
	});

	it("a late real receipt upgrades manual sent identity while preserving subsequent triage", async () => {
		const started = deferred(); const response = deferred<{ messageId: string }>();
		transport.mockImplementation(async () => { started.resolve(); return response.promise; });
		const sending = send({ requestId: "late-confirmed", requestPayload: {} });
		await started.promise; await recover();
		const existing = (await findDeliveryRequest(ctx, "late-confirmed", {}))!;
		const resolved = await resolveDelivery(ctx, projectSent, { attemptId: existing.attemptId, resolution: "sent" });
		const current = await ctx.storage.messages.getVersioned(resolved.id);
		await ctx.storage.messages.compareAndSet(resolved.id, current.revision, { ...current.value, status: "inbox", pinned: true, read: false });
		response.resolve({ messageId: "late-real@provider.example" });
		expect((await sending).deliveryStatus).toBe("sent");
		expect(await ctx.storage.messages.get(resolved.id)).toMatchObject({ status: "inbox", pinned: true, read: false, messageId: "<late-real@provider.example>", threadId: "<late-real@provider.example>" });
	});

	it("a stale manual-sent projector cannot replace a newer real receipt", async () => {
		const started = deferred(); const response = deferred<{ messageId: string }>();
		transport.mockImplementation(async () => { started.resolve(); return response.promise; });
		const sending = send({ requestId: "project-race", requestPayload: {} });
		await started.promise; await recover();
		const existing = (await findDeliveryRequest(ctx, "project-race", {}))!;
		const attempt = (await deliveries.get(existing.attemptId))!;
		const captured = deferred(); const resume = deferred();
		const read = ctx.storage.messages.getVersioned.bind(ctx.storage.messages);
		let paused = false;
		vi.spyOn(ctx.storage.messages, "getVersioned").mockImplementation(async (id: string) => {
			const value = await read(id);
			if (id === attempt.messageId && !paused) { paused = true; captured.resolve(); await resume.promise; }
			return value;
		});
		const resolving = resolveDelivery(ctx, projectSent, { attemptId: attempt.attemptId, resolution: "sent" });
		await captured.promise;
		response.resolve({ messageId: "<real-winner@provider.example>" });
		expect((await sending).deliveryStatus).toBe("sent");
		resume.resolve();
		await expect(resolving).rejects.toThrow("receipt changed");
		expect(await ctx.storage.messages.get(attempt.messageId)).toMatchObject({ status: "done", messageId: "<real-winner@provider.example>" });
		expect(await deliveries.get(attempt.attemptId)).toMatchObject({ state: "sent", receipt: { messageId: "<real-winner@provider.example>" } });
	});

	it("continues bounded recovery beyond the native 100-row page cap", async () => {
		const projector = vi.fn().mockRejectedValue(new Error("projection offline"));
		for (let i = 0; i < 105; i++) await send({}, projector);
		let total = 0;
		for (let i = 0; i < 5; i++) {
			const progress = await recover(projectSent, 25);
			expect(progress.inspected).toBeLessThanOrEqual(25);
			total += progress.recovered;
		}
		expect(total).toBe(105);
		expect((await deliveries.query({ where: { state: "accepted" }, limit: 100 })).items).toHaveLength(0);
		expect(transport).toHaveBeenCalledTimes(105);
	});
});
