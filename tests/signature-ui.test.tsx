import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/react";
import { ComposeView } from "../src/components/ComposeView";
import { ReplyCompose } from "../src/components/ReplyCompose";
import { SettingsPage } from "../src/components/SettingsPage";
import type { EmailSignature } from "../src/lib/signature";

let container: HTMLDivElement;
let root: Root;
let signature: EmailSignature = { text: "Alex <Studio> & Co\nDesigner", newMessages: true, replies: true };
let savedDraft: any;
let sent: any;
let signatureReads: number;
const quoteHtml = "<p></p><p>On Monday, Mara wrote:</p><blockquote><p>Original message</p></blockquote>";
function response(data: unknown) { return new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } }); }
async function server(path: string, init?: RequestInit) {
	const body = JSON.parse(init?.body as string ?? "{}");
	if (path.endsWith("signature/get")) { signatureReads++; return response({ signature, canSave: true }); }
	if (path.endsWith("signature/save")) { signature = body; return response({ signature }); }
	if (path.endsWith("settings/get")) return response({ senderAddress: "alex@example.com", inboundSecretSet: true });
	if (path.endsWith("messages/draft-save")) { savedDraft = body; return response({ draftId: "draft-1" }); }
	if (path.endsWith("messages/drafts")) return response({ items: [{ id: "draft-1", to: [], cc: [], bcc: [], subject: "", bodyHtml: savedDraft.html, bodyText: savedDraft.text, threadId: null }] });
	if (path.endsWith("messages/compose") || path.endsWith("messages/reply") || path.endsWith("messages/draft-send")) { sent = body.edits ?? body; return response({ id: "sent-1", threadId: "thread", attemptId: "attempt-1", deliveryStatus: "sent" }); }
	throw new Error(`Unexpected request: ${path}`);
}
async function act(action: () => void) { await React.act(async () => { action(); }); }
async function render(element: React.ReactNode) { await act(() => root.render(element)); }
function button(label: string) { const found = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label); expect(found, label).toBeDefined(); return found!; }
async function click(label: string) { await act(() => button(label).click()); }
function editorNode() { return container.querySelector<HTMLElement>('[role="textbox"][aria-label="Message body"]')!; }
function editor() { return (editorNode() as HTMLElement & { editor: Editor }).editor; }
function signatureEditor() { return (container.querySelector('[role="textbox"][aria-label="Email signature"]') as HTMLElement & { editor: Editor }).editor; }
async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
	await act(() => {
		Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function compose(mode: "new" | "reply", close = () => {}) {
	return mode === "new" ? <ComposeView draftId={null} onClose={close} /> : <ReplyCompose defaults={{ to: "mara@example.com", subject: "Re: Hello", quoteHtml }} inReplyTo="parent" threadId="thread" onSent={close} onDiscard={close} />;
}
beforeEach(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	// jsdom has no layout; ProseMirror's focus/scroll path measures a Range.
	Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
	Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function () { this.open = true; } });
	Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function () { this.open = false; } });
	container = document.createElement("div"); document.body.append(container); root = createRoot(container);
	signature = { text: "Alex <Studio> & Co\nDesigner", newMessages: true, replies: true };
	savedDraft = undefined; sent = undefined; signatureReads = 0;
	vi.stubGlobal("fetch", server);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("saves signature text and independent toggles without changing delivery settings, then reloads and clears it", async () => {
	await render(<SettingsPage />);
	expect(signatureEditor().getText()).toBe("Alex <Studio> & Co\nDesigner");
	await act(() => { signatureEditor().commands.setContent("<p>Warmly,<br>Alex</p>"); });
	const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
	await act(() => checkboxes[1].click());
	await click("Save signature");
	expect(signature).toMatchObject({ text: "Warmly,\nAlex", newMessages: true, replies: false });
	expect([...container.querySelectorAll('[role="status"]')].map(node => node.textContent)).toContain("Signature saved.");
	await render(<SettingsPage key="reload" />);
	expect(signatureEditor().getText()).toBe("Warmly,\nAlex");
	expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].checked).toBe(false);
	await act(() => { signatureEditor().commands.clearContent(); }); await click("Save signature");
	expect(signature.text).toBe("");
});

it("keeps signature edits available after a failed save", async () => {
	vi.stubGlobal("fetch", (path: string, init: RequestInit) => path.endsWith("signature/save") ? new Response(JSON.stringify({ error: { message: "Save interrupted" } }), { status: 503 }) : server(path, init));
	await render(<SettingsPage />); await act(() => { signatureEditor().commands.setContent("<p>Keep this signature</p>"); }); await click("Save signature");
	expect(signatureEditor().getText()).toBe("Keep this signature");
	expect(container.textContent).toContain("Save interrupted"); expect(container.textContent).not.toContain("Signature saved");
	expect(button("Save signature").disabled).toBe(false);
});

it.each(["new", "reply"] as const)("inserts an escaped, editable signature once in a %s message and sends the edited body", async mode => {
	await render(compose(mode));
	expect(editorNode()?.textContent).toContain("Alex <Studio> & Co");
	expect(editorNode().querySelector("studio")).toBeNull();
	expect(editorNode().firstElementChild?.textContent).toBe("");
	if (mode === "reply") expect(editor().getHTML().indexOf("Designer")).toBeLessThan(editor().getHTML().indexOf("On Monday"));
	await act(() => { editor().commands.insertContentAt(1, "Hello Mara"); });
	expect(container.textContent).toContain("Unsaved changes");
	await click(mode === "new" ? "Save as draft" : "Save draft");
	expect(savedDraft.text).toContain("Hello Mara"); expect(savedDraft.text.match(/Designer/g)).toHaveLength(1);
	await act(() => { editor().commands.setContent("<p>Hello Mara</p><p>Edited sign-off</p>"); });
	await click("Send");
	expect(sent.html).toBe("<p>Hello Mara</p><p>Edited sign-off</p>"); expect(sent.text).not.toContain("Designer");
});

it.each(["new", "reply"] as const)("does not warn about unsaved changes for an untouched %s signature", async mode => {
	let closed = false; await render(compose(mode, () => { closed = true; }));
	expect(editorNode()?.textContent).toContain("Designer"); expect(container.textContent).not.toContain("Unsaved changes");
	await click(mode === "new" ? "← Inbox" : "Close");
	expect(closed).toBe(true); expect(container.querySelector("dialog[open]")).toBeNull();
});

it.each(["new", "reply"] as const)("honors the %s signature toggle independently", async mode => {
	if (mode === "new") signature.newMessages = false; else signature.replies = false;
	await render(compose(mode)); expect(editorNode()).not.toBeNull(); expect(editorNode().textContent).not.toContain("Designer");
	if (mode === "reply") expect(editorNode().textContent).toContain("Original message");
});

it("resumes the exact saved signature even after the account signature changes", async () => {
	await render(compose("new")); await act(() => { editor().commands.insertContentAt(1, "A saved thought"); }); await click("Save as draft");
	const original = savedDraft.html; signature.text = "A replacement signature";
	await render(<ComposeView key="resume" draftId="draft-1" onClose={() => {}} />);
	expect(editor().getHTML()).toBe(original); expect(signatureReads).toBe(1);
	expect(editorNode().textContent?.match(/Designer/g)).toHaveLength(1); expect(editorNode().textContent).not.toContain("replacement");
	expect(container.textContent).not.toContain("Unsaved changes");
});

it("waits for the signature before allowing editing or sending", async () => {
	let finish!: (value: Response) => void;
	vi.stubGlobal("fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
	await render(compose("new")); expect(editorNode()).toBeNull(); expect(button("Send").disabled).toBe(true);
	await act(() => finish(response({ signature, canSave: true })));
	expect(editorNode().textContent).toContain("Designer"); expect(button("Send").disabled).toBe(false);
});

it.each(["retry", "skip"] as const)("offers %s when the signature cannot load", async recovery => {
	vi.stubGlobal("fetch", () => new Response(JSON.stringify({ error: { message: "Could not load signature" } }), { status: 503 }));
	await render(compose("reply")); expect(editorNode()).toBeNull(); expect(button("Send").disabled).toBe(true);
	vi.stubGlobal("fetch", server);
	await click(recovery === "retry" ? "Retry signature" : "Continue without signature");
	expect(editorNode().textContent).toContain("Original message");
	expect(editorNode().textContent?.includes("Designer")).toBe(recovery === "retry");
});

it("saves toolbar formatting and keeps it through compose, draft reopen and send", async () => {
	await render(<SettingsPage />);
	await act(() => { signatureEditor().commands.selectAll(); });
	await act(() => {
		const font = container.querySelector<HTMLSelectElement>('[aria-label="Font family"]')!;
		font.value = "Georgia"; font.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await act(() => {
		const size = container.querySelector<HTMLSelectElement>('[aria-label="Font size"]')!;
		size.value = "18px"; size.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await fill(container.querySelector<HTMLInputElement>('[aria-label="Text color"]')!, "#245be0");
	await click("Save signature");
	const savedStyle = new DOMParser().parseFromString(signature.html!, "text/html").querySelector("span")!.style;
	expect(savedStyle.fontFamily).toBe("Georgia"); expect(savedStyle.fontSize).toBe("18px"); expect(savedStyle.color).toBe("rgb(36, 91, 224)");
	await render(compose("new"));
	expect(editor().getHTML()).toContain("Georgia"); expect(editor().getHTML()).toContain("font-size: 18px");
	await click("Save as draft");
	await render(<ComposeView key="rich-resume" draftId="draft-1" onClose={() => {}} />);
	expect(editor().getHTML()).toContain("Georgia"); await click("Send");
	expect(sent.html).toContain("color: rgb(36, 91, 224)");
});

it("uploads a logo, retains it in a new signature and preserves it in replies", async () => {
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
	await render(<SettingsPage />);
	const upload = container.querySelector<HTMLInputElement>('[aria-label="Upload signature image"]')!;
	const file = new File([Uint8Array.from(atob(png), char => char.charCodeAt(0))], "studio.png", { type: "image/png" });
	Object.defineProperty(upload, "files", { configurable: true, value: [file] });
	await React.act(async () => { upload.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
	expect(container.querySelector('.dl-editor img')?.getAttribute("src")).toBe(`data:image/png;base64,${png}`);
	await act(() => { signatureEditor().commands.setNodeSelection(1); });
	await fill(container.querySelector<HTMLInputElement>('[aria-label="Image description"]')!, "Studio logo");
	expect(container.querySelector('[aria-label="Image description"]')).not.toBeNull();
	await act(() => {
		const width = container.querySelector<HTMLSelectElement>('[aria-label="Image width"]')!;
		width.value = "100"; width.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(container.querySelector('.dl-editor img')?.getAttribute("width")).toBe("100");
	await click("Save signature");
	expect(signature.html).toContain('alt="Studio logo"');
	expect(signature.html).toContain(`data:image/png;base64,${png}`);
	await render(compose("reply"));
	expect(editorNode().querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${png}`);
	expect(editor().getHTML().indexOf("data:image")).toBeLessThan(editor().getHTML().indexOf("On Monday"));
});


it("waits for an image upload before saving the signature", async () => {
	let finish!: () => void;
	vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function () {
		finish = () => { Object.defineProperty(this, "result", { value: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" }); this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>); };
	});
	await render(<SettingsPage />);
	const upload = container.querySelector<HTMLInputElement>('[aria-label="Upload signature image"]')!;
	Object.defineProperty(upload, "files", { configurable: true, value: [new File(["fixture"], "logo.png", { type: "image/png" })] });
	await act(() => upload.dispatchEvent(new Event("change", { bubbles: true })));
	expect(button("Save signature").disabled).toBe(true);
	await act(finish);
	expect(button("Save signature").disabled).toBe(false);
	await click("Save signature");
	expect(signature.html).toContain("data:image/png;base64,");
});
