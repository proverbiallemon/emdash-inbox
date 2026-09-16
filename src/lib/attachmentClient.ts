import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import type { PublicAttachment } from "./attachments";

const API = "/_emdash/api/plugins/emdash-inbox";
const MAX_FILES = 32;
const MAX_BYTES = 3 * 1024 * 1024;
const DOWNLOAD_CHUNK = 256 * 1024;

export async function postInbox<T>(path: string, body: unknown): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, "Request failed");
}
export function formatAttachmentSize(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
function encodeFile(bytes: Uint8Array): string {
	let result = "";
	for (const byte of bytes) result += String.fromCharCode(byte);
	return btoa(result);
}
export async function uploadDraftFiles(files: File[], options: {
	existing: PublicAttachment[];
	ensureDraft: () => Promise<string>;
	onUploaded: (file: PublicAttachment) => void;
}): Promise<void> {
	if (!files.length) return;
	if (files.length + options.existing.length > MAX_FILES) throw new Error("Attach at most 32 files.");
	if ([...files, ...options.existing].reduce((total, file) => total + file.size, 0) > MAX_BYTES) throw new Error("Attachments must total at most 3 MiB.");
	const draftId = await options.ensureDraft();
	for (const file of files) {
		const contentBase64 = encodeFile(new Uint8Array(await file.arrayBuffer()));
		const result = await postInbox<{ attachment: PublicAttachment }>("attachments/upload", {
			draftId, filename: file.name, mimeType: file.type || "application/octet-stream", contentBase64,
		});
		options.onUploaded(result.attachment);
	}
}

export async function downloadAttachmentBlob(messageId: string, attachment: PublicAttachment): Promise<Blob> {
	if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > 8 * 1024 * 1024) throw new Error("Invalid download size.");
	const parts: ArrayBuffer[] = [];
	let offset = 0;
	while (true) {
		const result = await postInbox<{ attachment: PublicAttachment; offset: number; contentBase64: string; nextOffset: number | null; done: boolean }>("attachments/read", {
			messageId, attachmentId: attachment.id, offset, limit: DOWNLOAD_CHUNK,
		});
		if (result.attachment.id !== attachment.id || result.attachment.size !== attachment.size || result.offset !== offset || result.contentBase64.length > 4 * Math.ceil(DOWNLOAD_CHUNK / 3)) throw new Error("Invalid attachment download response.");
		const binary = atob(result.contentBase64);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const next = offset + bytes.length;
		if (next > attachment.size || bytes.length > DOWNLOAD_CHUNK || (!result.done && (next <= offset || result.nextOffset !== next))) throw new Error("Attachment download did not advance correctly.");
		parts.push(bytes.buffer);
		if (result.done) {
			if (next !== attachment.size || result.nextOffset !== null) throw new Error("Incomplete attachment download.");
			return new Blob(parts, { type: "application/octet-stream" });
		}
		offset = next;
	}
}

export async function saveAttachmentDownload(messageId: string, attachment: PublicAttachment): Promise<void> {
	const blob = await downloadAttachmentBlob(messageId, attachment);
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	try {
		link.href = url; link.download = attachment.filename; link.hidden = true;
		document.body.append(link); link.click();
	} finally {
		link.remove();
		// Let the browser begin the download before releasing its local bytes.
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}
