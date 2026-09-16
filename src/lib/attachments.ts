/// <reference path="./cfBindingError.d.ts" />
import type { Attachment as ParsedAttachment } from "postal-mime";
import type { EmailAttachment } from "./cfBindingError";
import { publicAttachment, type StoredAttachment, type PublicAttachment } from "./attachmentMetadata";
export { publicAttachment, publicMessage } from "./attachmentMetadata";
export type { StoredAttachment, PublicAttachment } from "./attachmentMetadata";

export const MAX_INBOUND_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 32;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_DOWNLOAD_CHUNK = 256 * 1024;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();

export const attachmentCollections = { attachmentCleanup: { indexes: ["createdAt"] } };
export class AttachmentError extends Error {
	constructor(public readonly code: "bad_request" | "not_found" | "conflict" | "storage_unavailable", message: string) {
		super(message); this.name = "AttachmentError";
	}
}
function invalid(message: string): never { throw new AttachmentError("bad_request", message); }

interface PrivateBucket {
	put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType: string; cacheControl: string } }): Promise<unknown>;
	get(key: string, options?: { range: { offset: number; length: number } }): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
	delete(key: string): Promise<void>;
}
async function privateBucket(): Promise<PrivateBucket> {
	try {
		const { env } = await import("cloudflare:workers");
		const bucket = env.INBOX_ATTACHMENTS as PrivateBucket | undefined;
		if (bucket && typeof bucket.put === "function" && typeof bucket.get === "function" && typeof bucket.delete === "function") return bucket;
	} catch { /* The Workers binding is intentionally resolved only for file operations. */ }
	throw new AttachmentError("storage_unavailable", "Private attachment storage is unavailable. Configure a separate private INBOX_ATTACHMENTS R2 bucket.");
}

export function encodeBase64(bytes: Uint8Array): string {
	const chunks: string[] = [];
	for (let start = 0; start < bytes.length; start += 8192) {
		let chunk = "";
		for (let i = start; i < Math.min(start + 8192, bytes.length); i++) chunk += String.fromCharCode(bytes[i]);
		chunks.push(chunk);
	}
	return btoa(chunks.join(""));
}
export function decodeBase64(value: string, maxBytes = MAX_ATTACHMENT_BYTES): Uint8Array {
	if (typeof value !== "string") invalid("contentBase64: required base64 string");
	if (value.length > 4 * Math.ceil(maxBytes / 3)) invalid(`File exceeds ${maxBytes === MAX_INBOUND_BYTES ? "8" : "3"} MiB limit`);
	// A repeated-group base64 regex over a large valid message can exhaust the
	// JS regexp stack. Linear scans also keep validation memory bounded.
	if (value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) invalid("contentBase64: invalid base64 encoding");
	const firstPadding = value.indexOf("=");
	const padding = firstPadding === -1 ? 0 : value.length - firstPadding;
	if (padding > 2 || (padding === 2 && !value.endsWith("=="))) invalid("contentBase64: invalid base64 encoding");
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if (padding && (alphabet.indexOf(value[firstPadding - 1]) & (padding === 2 ? 15 : 3))) invalid("contentBase64: noncanonical base64 encoding");
	const binary = atob(value);
	if (binary.length > maxBytes) invalid(`File exceeds ${maxBytes === MAX_INBOUND_BYTES ? "8" : "3"} MiB limit`);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}
function filename(value: unknown, fallback = "attachment"): string {
	if (typeof value !== "string") return fallback;
	const basename = value.normalize("NFC").split(/[\\/]/).pop() ?? "";
	const clean = basename.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 180);
	return clean && clean !== "." && clean !== ".." ? clean : fallback;
}
function mimeType(value: unknown, strict = false): string {
	if (value === "" || value == null) return "application/octet-stream";
	if (typeof value === "string" && value.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)) return value.toLowerCase();
	if (strict) invalid("mimeType: invalid MIME type");
	return "application/octet-stream";
}
function contentId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value.trim().replace(/^<|>$/g, "");
	return clean.length > 0 && clean.length <= 255 && !/[\s<>\u0000-\u001f\u007f]/.test(clean) ? clean : undefined;
}
async function sha256(bytes: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
	return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function validateOutgoingSize(metadata: StoredAttachment[] = [], text = "", html = ""): void {
	if (!Array.isArray(metadata) || metadata.length > MAX_ATTACHMENT_COUNT) invalid("At most 32 attachments are supported");
	const size = metadata.reduce((total, item) => {
		if (!Number.isSafeInteger(item.size) || item.size < 0) invalid("Invalid attachment byte size");
		return total + item.size;
	}, 0);
	if (size > MAX_ATTACHMENT_BYTES) invalid("Attachments must total at most 3 MiB");
	const bodyBytes = encoder.encode(text).length + encoder.encode(html).length;
	if (bodyBytes > MAX_BODY_BYTES) invalid("Combined message body must be at most 256 KiB");
	// Base64 line wrapping plus ample headers/boundary allowance per part;
	// conservatively allow worst-case quoted-printable expansion of the body.
	const estimate = metadata.reduce((n, file) => n + 4 * Math.ceil(file.size / 3) * (78 / 76) + 4096, 16384 + bodyBytes * 3);
	if (estimate >= MAX_MESSAGE_BYTES) invalid("Encoded message exceeds the 5 MiB transport limit; reduce attachments or body");
}

async function currentDraft(ctx: any, draftId: string): Promise<{ value: any; revision: string }> {
	if (typeof draftId !== "string" || !draftId) invalid("draftId: required non-empty string");
	const draft = await ctx.storage.messages.getVersioned(draftId);
	if (!draft || draft.value.status !== "draft") throw new AttachmentError("not_found", "Draft not found");
	return draft;
}
async function writeObject(bucket: PrivateBucket, key: string, bytes: Uint8Array): Promise<void> {
	await bucket.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" } });
}

export async function uploadDraftAttachment(ctx: any, input: { draftId: string; filename: string; mimeType?: string; contentBase64: string }): Promise<{ attachment: PublicAttachment }> {
	const bytes = decodeBase64(input.contentBase64);
	const type = mimeType(input.mimeType, true);
	const current = await currentDraft(ctx, input.draftId);
	const id = crypto.randomUUID();
	const attachment: StoredAttachment = {
		id, objectKey: `files/${id}`, filename: filename(input.filename), mimeType: type,
		size: bytes.length, sha256: await sha256(bytes), disposition: "attachment",
	};
	const attachments = [...(current.value.attachments ?? []), attachment];
	validateOutgoingSize(attachments, current.value.bodyText ?? "", current.value.bodyHtml ?? "");
	const bucket = await privateBucket();
	try {
		await writeObject(bucket, attachment.objectKey, bytes);
	} catch (error) {
		await cleanupAttachments(ctx, [attachment]);
		throw error;
	}
	// A thrown database response can follow a committed write. Keep bytes in
	// that ambiguous case; deleting them could corrupt a successfully saved draft.
	const saved = await ctx.storage.messages.compareAndSet(input.draftId, current.revision, { ...current.value, attachments, sortAt: new Date().toISOString() });
	if (!saved.applied) {
		await cleanupAttachments(ctx, [attachment]);
		throw new AttachmentError("conflict", "Draft changed or was removed; reload before attaching files");
	}
	return { attachment: publicAttachment(attachment) };
}

export async function removeDraftAttachment(ctx: any, input: { draftId: string; attachmentId: string }): Promise<{ ok: true }> {
	const current = await currentDraft(ctx, input.draftId);
	const attachments: StoredAttachment[] = current.value.attachments ?? [];
	const attachment = attachments.find((file) => file.id === input.attachmentId);
	if (!attachment) throw new AttachmentError("not_found", "Attachment not found");
	const saved = await ctx.storage.messages.compareAndSet(input.draftId, current.revision, {
		...current.value, attachments: attachments.filter((file) => file.id !== input.attachmentId), sortAt: new Date().toISOString(),
	});
	if (!saved.applied) throw new AttachmentError("conflict", "Draft changed or was removed; reload before removing files");
	await cleanupAttachments(ctx, [attachment]);
	return { ok: true };
}

export async function readAttachment(ctx: any, input: { messageId: string; attachmentId: string; offset?: number; limit?: number }) {
	const offset = input.offset ?? 0;
	const limit = input.limit ?? MAX_DOWNLOAD_CHUNK;
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DOWNLOAD_CHUNK) invalid("Invalid attachment download range");
	const message = await ctx.storage.messages.get(input.messageId);
	const attachment = (message?.attachments as StoredAttachment[] | undefined)?.find((file) => file.id === input.attachmentId);
	if (!attachment) throw new AttachmentError("not_found", "Attachment not found");
	if (offset > attachment.size) invalid("Attachment download offset exceeds file size");
	const bucket = await privateBucket();
	const length = Math.min(limit, attachment.size - offset);
	const object = await bucket.get(attachment.objectKey, length > 0 ? { range: { offset, length } } : undefined);
	if (!object) throw new AttachmentError("not_found", "Attachment bytes are missing");
	if (object.size !== attachment.size) throw new AttachmentError("storage_unavailable", "Attachment size changed; download unavailable");
	const bytes = length === 0 ? new Uint8Array() : new Uint8Array(await object.arrayBuffer());
	if (bytes.length !== length) throw new AttachmentError("storage_unavailable", "Incomplete attachment download");
	const next = offset + bytes.length;
	return { attachment: publicAttachment(attachment), contentBase64: encodeBase64(bytes), offset, nextOffset: next < attachment.size ? next : null, done: next >= attachment.size };
}

/** The queue is written before deletion so transient R2 failures are recoverable. */
export async function cleanupAttachments(ctx: any, attachments: Array<StoredAttachment | string> = []): Promise<void> {
	if (!attachments.length) return;
	const queue = ctx.storage.attachmentCleanup;
	for (const attachment of attachments) {
		const objectKey = typeof attachment === "string" ? attachment : attachment.objectKey;
		await queue.put(objectKey, { objectKey, createdAt: new Date().toISOString() });
		try {
			await (await privateBucket()).delete(objectKey);
			await queue.delete(objectKey);
		} catch (error) { ctx.log?.warn?.("Attachment deletion queued for retry", { error: error instanceof Error ? error.message : "Storage error" }); }
	}
}
export async function retryAttachmentCleanup(ctx: any): Promise<{ deleted: number }> {
	const queue = ctx.storage.attachmentCleanup;
	const rows = await queue.query({ limit: 100 });
	let deleted = 0;
	if (!rows.items.length) return { deleted };
	const bucket = await privateBucket();
	for (const row of rows.items) {
		try { await bucket.delete(row.data.objectKey); await queue.delete(row.id); deleted++; }
		catch (error) { ctx.log?.warn?.("Attachment cleanup retry failed", { error: error instanceof Error ? error.message : "Storage error" }); }
	}
	return { deleted };
}

export async function storeInboundFiles(ctx: any, rawBytes: Uint8Array, parsed: { attachments: ParsedAttachment[] }): Promise<{ attachments: StoredAttachment[]; rawObjectKey: string }> {
	if (rawBytes.length > MAX_INBOUND_BYTES) invalid("Inbound message exceeds the supported 8 MiB raw MIME limit");
	if (parsed.attachments.length > MAX_ATTACHMENT_COUNT) invalid("Inbound messages support at most 32 attachments");
	const parts = parsed.attachments.map((part) => {
		const bytes = typeof part.content === "string"
			? (part.encoding === "utf8" ? encoder.encode(part.content) : decodeBase64(part.content, MAX_INBOUND_BYTES))
			: part.content instanceof Uint8Array ? part.content : new Uint8Array(part.content);
		return { part, bytes };
	});
	if (parts.reduce((sum, part) => sum + part.bytes.length, 0) > MAX_INBOUND_BYTES) invalid("Inbound decoded attachments exceed 8 MiB");
	const bucket = await privateBucket();
	const rawObjectKey = `raw/${crypto.randomUUID()}`;
	const keys: string[] = [];
	const attachments: StoredAttachment[] = [];
	try {
		keys.push(rawObjectKey); await writeObject(bucket, rawObjectKey, rawBytes);
		for (const { part, bytes } of parts) {
			const id = crypto.randomUUID();
			const cid = contentId(part.contentId);
			const attachment: StoredAttachment = {
				id, objectKey: `files/${id}`, filename: filename(part.filename, `attachment-${attachments.length + 1}`),
				mimeType: mimeType(part.mimeType), size: bytes.length, sha256: await sha256(bytes),
				disposition: part.disposition === "inline" ? "inline" : "attachment", ...(cid ? { contentId: cid } : {}),
			};
			keys.push(attachment.objectKey); await writeObject(bucket, attachment.objectKey, bytes);
			attachments.push(attachment);
		}
		return { attachments, rawObjectKey };
	} catch (error) { await cleanupAttachments(ctx, keys); throw error; }
}

export async function prepareOutgoingAttachments(ctx: any, metadata: StoredAttachment[] = [], text = "", html = ""): Promise<EmailAttachment[]> {
	validateOutgoingSize(metadata, text, html);
	if (!metadata.length) return [];
	const bucket = await privateBucket();
	const result: EmailAttachment[] = [];
	for (const file of metadata) {
		const object = await bucket.get(file.objectKey);
		if (!object) throw new AttachmentError("not_found", "Attachment bytes are missing; send cancelled");
		if (object.size !== file.size) throw new AttachmentError("storage_unavailable", "Attachment size changed; send cancelled");
		const bytes = new Uint8Array(await object.arrayBuffer());
		if (bytes.length !== file.size || await sha256(bytes) !== file.sha256) throw new AttachmentError("storage_unavailable", "Attachment integrity check failed; send cancelled");
		// The Workers binding accepts binary content directly. Passing base64 as
		// a string delivered those ASCII characters as the file in live testing.
		result.push({ content: bytes.buffer, filename: file.filename, type: file.mimeType, disposition: file.disposition, ...(file.contentId ? { contentId: file.contentId } : {}) });
	}
	return result;
}
