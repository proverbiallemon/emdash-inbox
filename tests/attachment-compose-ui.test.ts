import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeView } from "../src/components/ComposeView";
import { ReplyCompose } from "../src/components/ReplyCompose";
import { AttachmentDownloads } from "../src/components/AttachmentDownloads";

// The editor is an external rich-text dependency. Keep its stable interface;
// exercise the real compose controls, native API wrapper, and async lifecycle.
vi.mock("../src/components/TipTapEditor", () => ({
	TipTapEditor: ({ onReady }: { onReady: (editor: any) => void }) => {
		const editor = React.useMemo(() => ({ getHTML: () => "<p>Draft body</p>", getText: () => "Draft body", commands: { focus() {} }, setEditable() {} }), []);
		React.useEffect(() => { onReady(editor); }, [editor, onReady]);
		return React.createElement("div", { "data-editor": true });
	},
}));
vi.mock("../src/components/ComposeToolbar", () => ({ ComposeToolbar: () => null }));

const metadata = { id: "file-1", filename: "one.txt", mimeType: "text/plain", size: 1, sha256: "sha", disposition: "attachment" as const };
function response(data: unknown) { return new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function file(name = "one.txt") { const result = new File(["x"], name, { type: "text/plain" }); Object.defineProperty(result, "arrayBuffer", { value: async () => new Uint8Array([120]).buffer }); return result; }

describe("compose attachment interactions", () => {
	let container: HTMLDivElement; let root: Root;
	beforeEach(() => {
		(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div"); document.body.append(container); root = createRoot(container);
		vi.spyOn(window, "confirm").mockReturnValue(true);
	});
	afterEach(async () => { await React.act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
	async function render(element: React.ReactNode) { await React.act(async () => { root.render(element); }); }
	function button(label: string) { const found = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label); if (!found) throw new Error(`Missing button ${label}`); return found; }
	async function click(label: string) { await React.act(async () => { button(label).click(); }); }
	async function selectFiles(files: File[]) {
		const input = container.querySelector('input[type="file"]')!;
		Object.defineProperty(input, "files", { configurable: true, value: files });
		await React.act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
	}

	it("persists once, disables mutation controls during upload, and sends the same draft with retained files", async () => {
		const upload = deferred<Response>(); const calls: { path: string; body: any }[] = []; let closed = 0;
		vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string); calls.push({ path, body });
			if (path.endsWith("draft-save")) return response({ draftId: "draft-1" });
			if (path.endsWith("attachments/upload")) return upload.promise;
			return response({ id: "sent-message", threadId: "thread", deliveryStatus: "sent" });
		});
		await render(React.createElement(ComposeView, { draftId: null, onClose: () => { closed++; } }));
		await selectFiles([file()]);
		expect(calls.map((c) => c.path.split("/").pop())).toEqual(["draft-save", "upload"]);
		expect(button("Send").disabled).toBe(true); expect(button("Save draft").disabled).toBe(true); expect(button("Discard").disabled).toBe(true);
		await click("Send"); expect(calls).toHaveLength(2);
		await React.act(async () => { upload.resolve(response({ attachment: metadata })); });
		expect(container.textContent).toContain("one.txt");
		await click("Save draft"); expect(calls[2].body.draftId).toBe("draft-1");
		await click("Send"); expect(calls[3].path).toContain("draft-send"); expect(calls[3].body.draftId).toBe("draft-1"); expect(closed).toBe(1);
	});

	it("keeps an uploaded reference visible after a later upload fails and reuses the saved draft", async () => {
		const calls: { path: string; body: any }[] = [];
		vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string); calls.push({ path, body });
			if (path.endsWith("draft-save")) return response({ draftId: "draft-1" });
			if (body.filename === "two.txt") return new Response(JSON.stringify({ error: { message: "Upload interrupted" } }), { status: 503 });
			return response({ attachment: metadata });
		});
		await render(React.createElement(ComposeView, { draftId: null, onClose() {} }));
		await selectFiles([file(), file("two.txt")]);
		expect(container.textContent).toContain("one.txt"); expect(container.textContent).toContain("Upload interrupted");
		await click("Save draft"); expect(calls.at(-1)?.body.draftId).toBe("draft-1");
		expect(container.textContent).toContain("one.txt");
	});

	it("retains uploaded files on a failed save and prevents two same-tick save requests", async () => {
		const saving = deferred<Response>(); let saves = 0;
		vi.stubGlobal("fetch", async (path: string) => {
			if (path.endsWith("draft-save")) { saves++; return saves === 1 ? response({ draftId: "draft-1" }) : saving.promise; }
			return response({ attachment: metadata });
		});
		await render(React.createElement(ComposeView, { draftId: null, onClose() {} }));
		await selectFiles([file()]);
		await React.act(async () => { button("Save draft").click(); button("Save draft").click(); });
		expect(saves).toBe(2);
		await React.act(async () => { saving.resolve(new Response(JSON.stringify({ error: { message: "Save interrupted" } }), { status: 503 })); });
		expect(container.textContent).toContain("Save interrupted"); expect(container.textContent).toContain("one.txt");
		expect(button("Send").disabled).toBe(false);
	});

	it("removes a file from the UI only after the server accepts its removal", async () => {
		let removals = 0;
		vi.stubGlobal("fetch", async (path: string) => {
			if (path.endsWith("draft-save")) return response({ draftId: "draft-1" });
			if (path.endsWith("upload")) return response({ attachment: metadata });
			removals++; return removals === 1 ? new Response(JSON.stringify({ error: { message: "Removal interrupted" } }), { status: 503 }) : response({ ok: true });
		});
		await render(React.createElement(ComposeView, { draftId: null, onClose() {} })); await selectFiles([file()]);
		const remove = () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove one.txt"]')!;
		await React.act(async () => { remove().click(); });
		expect(container.textContent).toContain("one.txt"); expect(container.textContent).toContain("Removal interrupted");
		await React.act(async () => { remove().click(); }); expect(container.textContent).not.toContain("one.txt");
	});

	it("resumes attachment metadata and preserves it when closing a saved draft", async () => {
		const paths: string[] = []; let closed = 0;
		vi.stubGlobal("fetch", async (path: string) => {
			paths.push(path); return response({ items: [{ id: "draft-1", to: [], cc: [], bcc: [], subject: "Saved", bodyText: "Draft body", bodyHtml: "<p>Draft body</p>", threadId: null, attachments: [metadata] }] });
		});
		await render(React.createElement(ComposeView, { draftId: "draft-1", onClose: () => { closed++; } }));
		expect(container.textContent).toContain("one.txt"); await click("← Inbox");
		expect(closed).toBe(1); expect(paths.some((path) => path.includes("discard"))).toBe(false);
	});

	it("keeps the composer open if explicit saved-draft discard fails", async () => {
		let closed = 0;
		vi.stubGlobal("fetch", async (path: string) => path.endsWith("messages/drafts")
			? response({ items: [{ id: "draft-1", to: [], cc: [], bcc: [], subject: "Saved", bodyText: "Draft body", bodyHtml: "<p>Draft body</p>", threadId: null, attachments: [metadata] }] })
			: new Response(JSON.stringify({ error: { message: "Discard failed" } }), { status: 503 }));
		await render(React.createElement(ComposeView, { draftId: "draft-1", onClose: () => { closed++; } }));
		await click("Discard"); expect(closed).toBe(0); expect(container.textContent).toContain("Discard failed"); expect(container.textContent).toContain("one.txt");
	});

	it("sends an attached reply through its saved draft and cannot abort that send using Discard or Escape", async () => {
		const delivery = deferred<Response>(); const calls: { path: string; body: any; signal?: unknown }[] = []; let closed = 0; let sent = 0;
		vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
			calls.push({ path, body: JSON.parse(init.body as string), signal: init.signal });
			if (path.endsWith("draft-save")) return response({ draftId: "reply-draft" });
			if (path.endsWith("upload")) return response({ attachment: metadata });
			return delivery.promise;
		});
		await render(React.createElement(ReplyCompose, { defaults: { to: "reader@example.com", subject: "Re: files", quoteHtml: "" }, inReplyTo: "<parent@example.com>", threadId: "thread", onSent: () => { sent++; }, onDiscard: () => { closed++; } }));
		await selectFiles([file()]); await click("Send");
		expect(calls.at(-1)?.path).toContain("draft-send"); expect(calls.at(-1)?.body).toMatchObject({ draftId: "reply-draft", edits: { text: "Draft body" } });
		expect(button("Discard").disabled).toBe(true);
		await click("Discard"); await React.act(async () => { container.firstElementChild!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
		expect(closed).toBe(0); expect(calls.some((call) => call.path.includes("discard"))).toBe(false); expect(calls.at(-1)?.signal).toBeUndefined();
		await React.act(async () => { delivery.resolve(response({ id: "sent-message", threadId: "thread", deliveryStatus: "sent" })); }); expect(sent).toBe(1);
	});

	it("closes an attached reply without deletion, while explicit Discard deletes its saved draft", async () => {
		const calls: { path: string; body: any }[] = []; let closed = 0;
		vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
			calls.push({ path, body: JSON.parse(init.body as string) });
			return response(path.endsWith("draft-save") ? { draftId: "reply-draft" } : path.endsWith("upload") ? { attachment: metadata } : { ok: true });
		});
		await render(React.createElement(ReplyCompose, { defaults: { to: "reader@example.com", subject: "Re: files", quoteHtml: "" }, inReplyTo: "<parent@example.com>", threadId: "thread", onSent() {}, onDiscard: () => { closed++; } }));
		await selectFiles([file()]); await click("Close"); expect(closed).toBe(1); expect(calls.some((call) => call.path.includes("discard"))).toBe(false);
		await click("Discard"); expect(calls.at(-1)?.body).toEqual({ draftId: "reply-draft" }); expect(calls.at(-1)?.path).toContain("draft-discard"); expect(closed).toBe(2);
	});

	it("downloads using an octet-stream object URL and revokes it after the click", async () => {
		vi.useFakeTimers();
		const blobs: Blob[] = []; const revoked: string[] = []; const clicked: { href: string; download: string }[] = [];
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => { blobs.push(blob); return "blob:private-download"; } });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (url: string) => { revoked.push(url); } });
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push({ href: this.href, download: this.download }); });
		vi.stubGlobal("fetch", async () => response({ attachment: metadata, offset: 0, contentBase64: "eA==", nextOffset: null, done: true }));
		try {
			await render(React.createElement(AttachmentDownloads, { messageId: "message", attachments: [metadata] }));
			const download = container.querySelector("button")!; await React.act(async () => { download.click(); });
			expect(blobs[0].type).toBe("application/octet-stream"); expect(clicked).toEqual([{ href: "blob:private-download", download: "one.txt" }]);
			await React.act(async () => { await vi.runAllTimersAsync(); }); expect(revoked).toEqual(["blob:private-download"]);
		} finally { vi.useRealTimers(); }
	});
});
