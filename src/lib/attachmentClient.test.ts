// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadAttachmentBlob, uploadDraftFiles } from "./attachmentClient";
import type { PublicAttachment } from "./attachments";

const metadata: PublicAttachment = { id: "file-1", filename: "bytes.bin", mimeType: "application/octet-stream", size: 4, sha256: "sha", disposition: "attachment" };
function response(data: unknown) { return new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
afterEach(() => vi.unstubAllGlobals());

describe("attachment browser transport", () => {
	it("saves one draft before sequential uploads and keeps each successful file when a later upload fails", async () => {
		const first = deferred<Response>(); const started = deferred<void>(); const calls: { path: string; body: any }[] = [];
		vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
			expect(new Headers(init.headers).get("X-EmDash-Request")).toBe("1");
			calls.push({ path, body: JSON.parse(init.body as string) });
			if (calls.length === 1) { started.resolve(); return first.promise; }
			return new Response(JSON.stringify({ error: { message: "Second upload failed" } }), { status: 503 });
		});
		const accepted: PublicAttachment[] = []; let drafts = 0;
		const uploading = uploadDraftFiles([new File([new Uint8Array([0, 255, 1, 2])], "first.bin"), new File(["b"], "second.txt")], {
			existing: [], ensureDraft: async () => { drafts++; return "draft-1"; }, onUploaded: (file) => { accepted.push(file); },
		}).catch((error) => error);
		await started.promise; expect(drafts).toBe(1); expect(calls).toHaveLength(1);
		expect(calls[0].body).toMatchObject({ draftId: "draft-1", contentBase64: "AP8BAg==" });
		first.resolve(response({ attachment: metadata }));
		expect(await uploading).toMatchObject({ message: "Second upload failed" });
		expect(accepted).toEqual([metadata]); expect(calls).toHaveLength(2); expect(calls[1].body.draftId).toBe("draft-1");
	});

	it("rejects oversized selections before saving a draft or uploading any file", async () => {
		let draftSaved = false;
		await expect(uploadDraftFiles([new File([new Uint8Array(3 * 1024 * 1024 + 1)], "too-large.bin")], {
			existing: [], ensureDraft: async () => { draftSaved = true; return "draft"; }, onUploaded() {},
		})).rejects.toThrow(/3 MiB/);
		expect(draftSaved).toBe(false);
	});

	it("assembles authenticated download chunks into a non-rendering Blob", async () => {
		const offsets: number[] = [];
		vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
			expect(new Headers(init.headers).get("X-EmDash-Request")).toBe("1");
			const input = JSON.parse(init.body as string); offsets.push(input.offset);
			return response({ attachment: metadata, offset: input.offset, contentBase64: input.offset === 0 ? "AP8=" : "AQI=", nextOffset: input.offset === 0 ? 2 : null, done: input.offset !== 0 });
		});
		const blob = await downloadAttachmentBlob("message", metadata);
		expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1, 2]));
		expect(blob.type).toBe("application/octet-stream"); expect(offsets).toEqual([0, 2]);
	});

	it.each([
		{ offset: 0, contentBase64: "AP8=", nextOffset: 0, done: false },
		{ offset: 0, contentBase64: "AP8=", nextOffset: null, done: true },
	])("rejects incomplete or non-advancing downloads", async (chunk) => {
		vi.stubGlobal("fetch", async () => response({ attachment: metadata, ...chunk }));
		await expect(downloadAttachmentBlob("message", metadata)).rejects.toThrow(/download/i);
	});
});
