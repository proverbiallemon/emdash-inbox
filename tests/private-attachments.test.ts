// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginStorageRepository } from "emdash";
import PostalMime from "postal-mime";
import { createNativeHost } from "./helpers/nativeHost";
import { draftDiscard, draftSave, draftSend } from "../src/lib/composeOps";
import {
	decodeBase64, encodeBase64, publicMessage, uploadDraftAttachment, removeDraftAttachment,
	readAttachment, storeInboundFiles, prepareOutgoingAttachments, retryAttachmentCleanup,
	type StoredAttachment,
} from "../src/lib/attachments";

const objects = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), failDelete: false, afterPut: undefined as undefined | (() => Promise<void>) }));
vi.mock("cloudflare:workers", () => ({ env: { INBOX_ATTACHMENTS: {
	async put(key: string, bytes: Uint8Array) { objects.files.set(key, new Uint8Array(bytes)); await objects.afterPut?.(); },
	async get(key: string, options?: { range?: { offset: number; length: number } }) {
		const bytes = objects.files.get(key); if (!bytes) return null;
		const result = options?.range ? bytes.slice(options.range.offset, options.range.offset + options.range.length) : bytes;
		return { size: bytes.length, arrayBuffer: async () => new Uint8Array(result).buffer };
	},
	async delete(key: string) { if (objects.failDelete) throw new Error("R2 temporarily unavailable"); objects.files.delete(key); },
} } }));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

describe("private attachments with native SQLite draft revisions", () => {
	let host: Awaited<ReturnType<typeof createNativeHost>>;
	let ctx: any;
	beforeEach(async () => {
		objects.files.clear(); objects.failDelete = false; objects.afterPut = undefined;
		host = await createNativeHost();
		ctx = {
			storage: { messages: host.messages, attachmentCleanup: new PluginStorageRepository(host.db, "emdash-inbox", "attachmentCleanup", ["createdAt"]) },
			kv: { get: async () => "owner@example.com" }, log: { error() {}, warn() {} },
		};
	});
	afterEach(async () => { vi.restoreAllMocks(); await host?.close(); });
	async function draft() { return (await draftSave(ctx, { to: "reader@example.com", subject: "Files", text: "Attached" })).draftId; }
	async function upload(draftId: string, contentBase64 = "AP8BAg==") {
		return uploadDraftAttachment(ctx, { draftId, filename: "C:\\private\\../invoice\r\n.pdf", mimeType: "application/pdf", contentBase64 });
	}
	async function stored(draftId: string): Promise<StoredAttachment[]> { return ((await host.messages.get(draftId)) as any).attachments; }

	it("preserves arbitrary bytes, hides storage keys, and enforces message membership on downloads", async () => {
		const id = await draft();
		const uploaded = await upload(id);
		expect(uploaded.attachment).toMatchObject({ filename: "invoice.pdf", size: 4, mimeType: "application/pdf" });
		expect(uploaded.attachment).not.toHaveProperty("objectKey");
		const file = (await stored(id))[0];
		expect(objects.files.get(file.objectKey)).toEqual(new Uint8Array([0, 255, 1, 2]));
		const first = await readAttachment(ctx, { messageId: id, attachmentId: file.id, limit: 2 });
		expect(first).toMatchObject({ contentBase64: "AP8=", nextOffset: 2, done: false });
		expect(await readAttachment(ctx, { messageId: id, attachmentId: file.id, offset: 2, limit: 2 })).toMatchObject({ contentBase64: "AQI=", nextOffset: null, done: true });
		await expect(readAttachment(ctx, { messageId: await draft(), attachmentId: file.id })).rejects.toThrow(/not found/i);
		expect(publicMessage({ ...(await host.messages.get(id))!, bodyRaw: "private MIME", rawObjectKey: "private/raw" })).not.toHaveProperty("bodyRaw");
		expect(JSON.stringify(publicMessage((await host.messages.get(id))!))).not.toContain(file.objectKey);
		expect(publicMessage({ subject: "Visible", indexDirty: true, indexPreviousThreadIds: ["internal"], indexSchemaVersion: 1, messageKey: "private-index" })).toEqual({ subject: "Visible" });
	});

	it.each(["not base64!", "AA=", "A===", "AB==", "AP8BAg==\n"])("rejects malformed or noncanonical base64 %s without storing bytes", async (bad) => {
		await expect(upload(await draft(), bad)).rejects.toThrow(/base64/i);
		expect(objects.files.size).toBe(0);
	});

	it("rejects oversized decoded files, unsafe MIME, and additions beyond the aggregate limit", async () => {
		const id = await draft();
		await expect(upload(id, Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64"))).rejects.toThrow(/3 MiB/i);
		await expect(uploadDraftAttachment(ctx, { draftId: id, filename: "a", mimeType: "text/html\r\nHeader: injection", contentBase64: "AA==" })).rejects.toThrow(/MIME/i);
		await upload(id, Buffer.alloc(3 * 1024 * 1024).toString("base64"));
		await expect(upload(id, "AA==")).rejects.toThrow(/3 MiB/i);
		expect((await stored(id))).toHaveLength(1);
	});

	it("cleans a newly uploaded object when a concurrent discard wins the real draft CAS", async () => {
		const id = await draft(); const reached = deferred(); const release = deferred();
		objects.afterPut = async () => { reached.resolve(); await release.promise; };
		const uploading = upload(id); const outcome = uploading.catch((error) => error);
		await reached.promise; await draftDiscard(ctx, { draftId: id }); release.resolve();
		expect(await outcome).toBeInstanceOf(Error);
		expect(await host.messages.get(id)).toBeNull();
		expect(objects.files.size).toBe(0);
	});

	it("retains uploaded bytes when the SQL write commits but its acknowledgement fails", async () => {
		const id = await draft();
		const write = host.messages.compareAndSet.bind(host.messages);
		vi.spyOn(host.messages, "compareAndSet").mockImplementation(async (...args) => {
			await write(...args); throw new Error("SQL response interrupted after commit");
		});
		await expect(upload(id)).rejects.toThrow("SQL response interrupted");
		const file = (await stored(id))[0];
		expect(objects.files.get(file.objectKey)).toEqual(new Uint8Array([0, 255, 1, 2]));
		expect((await ctx.storage.attachmentCleanup.query()).items).toHaveLength(0);
	});

	it("preserves concurrent draft text edits when an upload loses its CAS", async () => {
		const id = await draft(); const reached = deferred(); const release = deferred();
		objects.afterPut = async () => { reached.resolve(); await release.promise; };
		const uploading = upload(id).catch((error) => error);
		await reached.promise; await draftSave(ctx, { draftId: id, text: "Newer edits" }); release.resolve();
		expect(await uploading).toBeInstanceOf(Error);
		expect((await host.messages.get(id))?.bodyText).toBe("Newer edits"); expect(objects.files.size).toBe(0);
	});

	it("rejects a stale attachment removal without deleting a sent message's objects", async () => {
		const id = await draft(); await upload(id); const file = (await stored(id))[0];
		const read = host.messages.getVersioned.bind(host.messages); const reached = deferred(); const release = deferred();
		vi.spyOn(host.messages, "getVersioned").mockImplementationOnce(async (key) => {
			const result = await read(key); reached.resolve(); await release.promise; return result;
		});
		const removing = removeDraftAttachment(ctx, { draftId: id, attachmentId: file.id }).catch((error) => error);
		await reached.promise; await draftSend(ctx, async () => null, { draftId: id }); release.resolve();
		expect(await removing).toBeInstanceOf(Error); expect(objects.files.has(file.objectKey)).toBe(true);
	});

	it("requires draft membership for upload and rejects invalid download ranges", async () => {
		await expect(upload("missing-draft")).rejects.toThrow(/not found/i); expect(objects.files.size).toBe(0);
		const id = await draft(); await upload(id); const file = (await stored(id))[0];
		for (const range of [{ offset: -1 }, { limit: 0 }, { limit: 256 * 1024 + 1 }, { offset: 5 }, { offset: 0.5 }]) {
			await expect(readAttachment(ctx, { messageId: id, attachmentId: file.id, ...range })).rejects.toThrow(/range|offset/i);
		}
	});

	it("retains attachment references after rejected delivery and after accepted delivery without sent persistence", async () => {
		const id = await draft(); await upload(id); const refs = await stored(id);
		await expect(draftSend(ctx, async () => { throw new Error("transport rejection"); }, { draftId: id })).rejects.toThrow("transport rejection");
		expect(await stored(id)).toEqual(refs);
		let sent: unknown;
		await draftSend(ctx, async (_ctx, event) => { sent = event.message.attachments; return null; }, { draftId: id });
		expect(sent).toEqual(refs); expect(await host.messages.get(id)).toBeNull();
		expect(objects.files.has(refs[0].objectKey)).toBe(true);
	});

	it("does not claim or send a draft with missing attachment bytes", async () => {
		const id = await draft(); await upload(id); objects.files.clear();
		let delivered = false;
		await expect(draftSend(ctx, async () => { delivered = true; return null; }, { draftId: id })).rejects.toThrow(/missing|unavailable/i);
		expect(delivered).toBe(false); expect(await host.messages.get(id)).not.toBeNull();
	});

	it("queues failed deletion durably after removing the reference and later retries it", async () => {
		const id = await draft(); await upload(id); const file = (await stored(id))[0]; objects.failDelete = true;
		await removeDraftAttachment(ctx, { draftId: id, attachmentId: file.id });
		expect(await stored(id)).toEqual([]); expect(objects.files.has(file.objectKey)).toBe(true);
		expect((await ctx.storage.attachmentCleanup.query()).items).toHaveLength(1);
		objects.failDelete = false; await retryAttachmentCleanup(ctx);
		expect(objects.files.size).toBe(0); expect((await ctx.storage.attachmentCleanup.query()).items).toHaveLength(0);
	});

	it("deletes attachments only after a discard wins and prevents removing a claimed send's files", async () => {
		const first = await draft(); await upload(first); await draftDiscard(ctx, { draftId: first }); expect(objects.files.size).toBe(0);
		const id = await draft(); await upload(id); const file = (await stored(id))[0];
		const reached = deferred(); const finish = deferred();
		const sending = draftSend(ctx, async () => { reached.resolve(); await finish.promise; return null; }, { draftId: id });
		await reached.promise;
		await expect(removeDraftAttachment(ctx, { draftId: id, attachmentId: file.id })).rejects.toThrow(/not found/i);
		expect(objects.files.has(file.objectKey)).toBe(true); finish.resolve(); await sending;
	});

	it("stores parsed inbound bytes and original MIME privately without embedding keys in public messages", async () => {
		const raw = new TextEncoder().encode('From: sender@example.com\r\nTo: reader@example.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="boundary"\r\n\r\n--boundary\r\nContent-Type: text/plain\r\n\r\nHello\r\n--boundary\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="bytes.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAP8BAg==\r\n--boundary--\r\n');
		const parsed = await PostalMime.parse(raw);
		const result = await storeInboundFiles(ctx, raw, parsed);
		expect(objects.files.get(result.rawObjectKey)).toEqual(raw);
		expect(objects.files.get(result.attachments[0].objectKey)).toEqual(new Uint8Array([0, 255, 1, 2]));
		expect(result.attachments[0]).toMatchObject({ filename: "bytes.bin", size: 4 });
		const payload = await prepareOutgoingAttachments(ctx, result.attachments, "Hello", "<p>Hello</p>");
		expect(payload).toEqual([expect.objectContaining({ filename: "bytes.bin", type: "application/octet-stream", disposition: "attachment" })]);
		expect(payload[0].content).toBeInstanceOf(ArrayBuffer);
		expect(new Uint8Array(payload[0].content as ArrayBuffer)).toEqual(new Uint8Array([0, 255, 1, 2]));
	});

	it("rejects inbound raw size or part count before any object is stored", async () => {
		await expect(storeInboundFiles(ctx, new Uint8Array(8 * 1024 * 1024 + 1), { attachments: [] })).rejects.toThrow(/8 MiB/i);
		const part = { filename: "a", mimeType: "text/plain", disposition: "attachment" as const, content: new Uint8Array([1]) };
		await expect(storeInboundFiles(ctx, new Uint8Array([1]), { attachments: Array(33).fill(part) })).rejects.toThrow(/32/i);
		expect(objects.files.size).toBe(0);
	});

	it("bounds outgoing body bytes and detects object corruption before producing a transport payload", async () => {
		const id = await draft(); await upload(id); const refs = await stored(id);
		await expect(prepareOutgoingAttachments(ctx, refs, "a".repeat(256 * 1024 + 1))).rejects.toThrow(/body/i);
		objects.files.set(refs[0].objectKey, new Uint8Array([0, 1, 1, 2]));
		await expect(prepareOutgoingAttachments(ctx, refs, "ok")).rejects.toThrow(/integrity|changed/i);
	});

	it("round-trips large binary chunks without spread-call limits", () => {
		const bytes = new Uint8Array(256 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
		expect(decodeBase64(encodeBase64(bytes), bytes.length)).toEqual(bytes);
	});

	it("accepts canonical base64 at the full inbound limit without regex stack overflow", () => {
		const encoded = Buffer.alloc(8 * 1024 * 1024, 183).toString("base64");
		const decoded = decodeBase64(encoded, 8 * 1024 * 1024);
		expect(decoded.byteLength).toBe(8 * 1024 * 1024);
		expect(decoded[0]).toBe(183); expect(decoded.at(-1)).toBe(183);
	});
});
