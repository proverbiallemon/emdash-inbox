// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MessageDoc } from "../index";
import { ComposeError, draftDiscard, draftSave, draftSend, type Deliver } from "./composeOps";

function draftDoc(overrides: Partial<MessageDoc> = {}): MessageDoc {
	return {
		messageId: "<draft-1@local>",
		direction: "outbound",
		from: "me@example.com",
		to: "reader@example.com",
		toAll: ["reader@example.com"],
		cc: [],
		bcc: [],
		subject: "A draft",
		bodyText: "Old text",
		bodyHtml: "<p><strong>Old text</strong></p>",
		bodyRaw: null,
		threadId: null,
		receivedAt: "2026-09-16T12:00:00Z",
		source: "emdash-inbox:draft",
		status: "draft",
		pinned: false,
		read: true,
		bundleId: null,
		sortAt: "2026-09-16T12:00:00Z",
		snoozeUntil: null,
		inReplyTo: null,
		...overrides,
	};
}

type VersionedDraft = { value: MessageDoc; revision: string };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Copies values like JSON storage and changes revision on every successful write. */
class MemoryMessages {
	private rows = new Map<string, VersionedDraft>();
	private revision = 0;
	private afterRead?: () => Promise<void>;

	constructor(doc: MessageDoc) {
		this.write("d1", doc);
	}

	private write(id: string, value: MessageDoc): string {
		const revision = String(++this.revision);
		this.rows.set(id, { value: structuredClone(value), revision });
		return revision;
	}

	async getVersioned(id: string): Promise<VersionedDraft | null> {
		const snapshot = structuredClone(this.rows.get(id) ?? null);
		await this.afterRead?.();
		return snapshot;
	}

	/** Hold the next reads after capturing their snapshots to force a known race. */
	pauseReads(count = 1) {
		const reached = deferred<void>();
		const resume = deferred<void>();
		this.afterRead = async () => {
			if (--count === 0) {
				this.afterRead = undefined;
				reached.resolve();
			}
			await resume.promise;
		};
		return { reached: reached.promise, resume: resume.resolve };
	}

	async get(id: string): Promise<MessageDoc | null> {
		return (await this.getVersioned(id))?.value ?? null;
	}

	async put(id: string, value: MessageDoc): Promise<void> {
		this.write(id, value);
	}

	async delete(id: string): Promise<void> {
		this.rows.delete(id);
	}

	async compareAndSet(id: string, expectedRevision: string | null, value: MessageDoc) {
		if ((this.rows.get(id)?.revision ?? null) !== expectedRevision) {
			return { applied: false as const };
		}
		return { applied: true as const, revision: this.write(id, value) };
	}

	async compareAndDelete(id: string, expectedRevision: string) {
		if (this.rows.get(id)?.revision !== expectedRevision) return { applied: false };
		this.rows.delete(id);
		return { applied: true };
	}
}

function setup(doc = draftDoc()) {
	const messages = new MemoryMessages(doc);
	const sent: Parameters<Deliver>[1][] = [];
	const deliver: Deliver = async (_ctx, event) => {
		sent.push(event);
		return { id: "sent-1", threadId: "thread-1" };
	};
	return { ctx: { storage: { messages } }, messages, sent, deliver };
}

describe("draft body consistency", () => {
	it("sends regenerated HTML after saving a plain-text edit to an HTML draft", async () => {
		const { ctx, deliver, sent } = setup();

		await draftSave(ctx, { draftId: "d1", text: "New & <safe>\nSecond line" });
		await draftSend(ctx, deliver, { draftId: "d1" });

		expect(sent[0].message).toMatchObject({
			text: "New & <safe>\nSecond line",
			html: "<p>New &amp; &lt;safe&gt;<br>Second line</p>",
		});
	});

	it("sends regenerated HTML when send edits replace only plain text", async () => {
		const { ctx, deliver, sent } = setup();

		await draftSend(ctx, deliver, { draftId: "d1", edits: { text: "Final <word>" } });

		expect(sent[0].message).toMatchObject({
			text: "Final <word>",
			html: "<p>Final &lt;word&gt;</p>",
		});
	});

	it("retains rich HTML when a save changes only the subject", async () => {
		const { ctx, deliver, sent } = setup();

		await draftSave(ctx, { draftId: "d1", subject: "New subject" });
		await draftSend(ctx, deliver, { draftId: "d1" });

		expect(sent[0].message).toMatchObject({
			subject: "New subject",
			html: "<p><strong>Old text</strong></p>",
		});
	});

	it("uses explicit replacement HTML alongside saved and sent text edits", async () => {
		const { ctx, deliver, sent, messages } = setup();

		await draftSave(ctx, { draftId: "d1", text: "Saved", html: "<p><em>Saved</em></p>" });
		expect((await messages.get("d1"))?.bodyHtml).toBe("<p><em>Saved</em></p>");
		await draftSend(ctx, deliver, {
			draftId: "d1",
			edits: { text: "Final", html: "<p><strong>Final</strong></p>" },
		});

		expect(sent[0].message).toMatchObject({ text: "Final", html: "<p><strong>Final</strong></p>" });
	});
});

describe("draft send handoff", () => {
	it("passes the exact revision and final snapshot to delivery without removing the draft", async () => {
		const { ctx, messages, sent, deliver } = setup(draftDoc({ threadId: "t1", inReplyTo: "<parent@example.com>" }));
		const original = await messages.getVersioned("d1");
		const outcome = await draftSend(ctx, deliver, {
			draftId: "d1",
			edits: {
				to: "new@example.com, other@example.com", cc: "copy@example.com", bcc: "hidden@example.com",
				subject: "Updated subject", text: "Latest <text>",
			},
		});
		expect(outcome).toEqual({ id: "sent-1", threadId: "thread-1" });
		expect(sent).toHaveLength(1);
		expect(sent[0].draftClaim).toMatchObject({
			id: "d1", revision: original!.revision,
			snapshot: {
				status: "draft", to: "new@example.com", toAll: ["new@example.com", "other@example.com"],
				cc: ["copy@example.com"], bcc: ["hidden@example.com"], subject: "Updated subject",
				bodyText: "Latest <text>", bodyHtml: "<p>Latest &lt;text&gt;</p>",
				threadId: "t1", inReplyTo: "<parent@example.com>",
			},
		});
		expect(await messages.getVersioned("d1")).toEqual(original);
		await draftSave(ctx, { draftId: "d1", text: "Later edit" });
		expect(sent[0].draftClaim!.snapshot.bodyText).toBe("Latest <text>");
		expect(sent[0].draftClaim!.revision).toBe(original!.revision);
	});

	it("preserves the delivery result including an uncertain attempt", async () => {
		const { ctx, messages } = setup();
		const original = await messages.getVersioned("d1");
		const uncertain = { id: null, threadId: null, attemptId: "attempt-1", deliveryStatus: "uncertain" as const };
		expect(await draftSend(ctx, async () => uncertain, { draftId: "d1" })).toEqual(uncertain);
		expect(await messages.getVersioned("d1")).toEqual(original);
	});

	it("leaves restoration to delivery and propagates a preflight error without rewriting a concurrent edit", async () => {
		const { ctx, messages } = setup();
		const deliveryStarted = deferred<void>();
		const delivery = deferred<Awaited<ReturnType<Deliver>>>();
		const failure = new Error("Preflight unavailable");
		const outcome = expect(draftSend(ctx, async () => {
			deliveryStarted.resolve();
			return delivery.promise;
		}, { draftId: "d1", edits: { text: "Send edit" } })).rejects.toBe(failure);
		await deliveryStarted.promise;
		await draftSave(ctx, { draftId: "d1", text: "Concurrent edit" });
		const replacement = await messages.getVersioned("d1");
		delivery.reject(failure);
		await outcome;
		expect(await messages.getVersioned("d1")).toEqual(replacement);
	});

	it.each([
		{ to: [] },
		{ to: "invalid-address" },
		{ cc: "invalid-address" },
		{ bcc: "invalid-address" },
		{ subject: " " },
		{ text: " " },
	])("validates edits before claiming the draft: %j", async (edits) => {
		const original = draftDoc();
		const { ctx, messages, sent, deliver } = setup(original);
		const before = await messages.getVersioned("d1");

		await expect(draftSend(ctx, deliver, { draftId: "d1", edits })).rejects.toBeInstanceOf(ComposeError);

		expect(sent).toHaveLength(0);
		expect(await messages.getVersioned("d1")).toEqual(before);
	});
});

describe("draft revision conflicts", () => {
	it("a stale save cannot resurrect a discarded draft", async () => {
		const { ctx, messages } = setup();
		const reads = messages.pauseReads();
		const staleSave = Promise.allSettled([draftSave(ctx, { draftId: "d1", text: "Stale text" })]);
		await reads.reached;
		await draftDiscard(ctx, { draftId: "d1" });
		reads.resume();
		expect((await staleSave)[0].status).toBe("rejected");
		expect(await messages.get("d1")).toBeNull();
	});

	it("a stale save cannot overwrite a concurrent save", async () => {
		const { ctx, messages } = setup();
		const reads = messages.pauseReads();
		const staleSave = Promise.allSettled([draftSave(ctx, { draftId: "d1", text: "Stale text" })]);
		await reads.reached;
		await draftSave(ctx, { draftId: "d1", text: "Latest text" });
		reads.resume();
		expect((await staleSave)[0].status).toBe("rejected");
		expect((await messages.get("d1"))?.bodyText).toBe("Latest text");
	});

	it("a stale discard cannot remove a newly saved revision", async () => {
		const { ctx, messages } = setup();
		const reads = messages.pauseReads();
		const staleDiscard = Promise.allSettled([draftDiscard(ctx, { draftId: "d1" })]);
		await reads.reached;
		await draftSave(ctx, { draftId: "d1", text: "Latest text" });
		reads.resume();
		expect((await staleDiscard)[0].status).toBe("rejected");
		expect((await messages.get("d1"))?.bodyText).toBe("Latest text");
	});
});
