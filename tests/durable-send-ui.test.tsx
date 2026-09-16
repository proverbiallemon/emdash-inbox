import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposeView } from "../src/components/ComposeView";
import { ReplyCompose } from "../src/components/ReplyCompose";
import { pages } from "../src/admin";

vi.mock("../src/components/TipTapEditor", () => ({
	TipTapEditor: ({ onReady }: { onReady: (editor: any) => void }) => {
		const editor = React.useMemo(() => ({ getHTML: () => "<p>Delivery body</p>", getText: () => "Delivery body", commands: { focus() {} }, setEditable() {} }), []);
		React.useEffect(() => { onReady(editor); }, [editor, onReady]);
		return React.createElement("div", { "data-editor": true });
	},
}));
vi.mock("../src/components/ComposeToolbar", () => ({ ComposeToolbar: () => null }));

let container: HTMLDivElement; let root: Root;
function response(data: unknown) { return new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } }); }
function button(label: string) { const found = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label); expect(found, `Missing button ${label}`).toBeDefined(); return found!; }
async function click(label: string) { await React.act(async () => { button(label).click(); }); }
async function render(element: React.ReactNode) { await React.act(async () => { root.render(element); }); }
async function fill(label: string, value: string) {
	const input = [...container.querySelectorAll("label")].find((node) => node.textContent?.trim() === label)?.querySelector("input");
	expect(input).toBeDefined();
	await React.act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input!.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
beforeEach(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	window.history.replaceState({}, "", "/_emdash/admin/plugins/emdash-inbox");
	container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await React.act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["pending", "uncertain"] as const)("keeps a %s compose protected and directs recovery to Outbox", async (deliveryStatus) => {
	let closed = 0; let sends = 0;
	vi.stubGlobal("fetch", async () => { sends++; return response({ id: null, threadId: null, attemptId: "attempt-1", deliveryStatus }); });
	await render(<ComposeView draftId={null} onClose={() => { closed++; }} />);
	await click("Send");
	expect(closed).toBe(0); expect(button("Send").disabled).toBe(true); expect(button("Discard").disabled).toBe(true);
	expect(container.querySelector('a[href*="status=outbox"]')).not.toBeNull();
	await click("Send");
	await React.act(async () => { container.firstElementChild!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
	expect(sends).toBe(1); expect(container.textContent).not.toContain("Sent successfully");
});

it("does not call a reply sent callback for an uncertain result", async () => {
	const sent = vi.fn();
	vi.stubGlobal("fetch", async () => response({ id: null, threadId: null, attemptId: "reply-attempt", deliveryStatus: "uncertain" }));
	await render(<ReplyCompose defaults={{ to: "reader@example.com", subject: "Re: Hello", quoteHtml: "" }} inReplyTo="parent" threadId="thread" onSent={sent} onDiscard={() => {}} />);
	await click("Send");
	expect(sent).not.toHaveBeenCalled(); expect(button("Send").disabled).toBe(true);
	expect(container.querySelector('a[href*="status=outbox"]')).not.toBeNull();
});

it.each([["compose", "network"], ["draft", "server"], ["reply", "malformed"]] as const)("retries the original %s request after a %s failure without changing its key", async (mode, failure) => {
	const requests: any[] = []; let closed = 0;
	vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
		if (path.endsWith("messages/drafts")) return response({ items: [{ id: "saved-draft", to: ["reader@example.com"], cc: [], bcc: [], subject: "Saved", bodyText: "Delivery body", bodyHtml: "<p>Delivery body</p>", threadId: null }] });
		requests.push(JSON.parse(init.body as string));
		if (requests.length === 1) {
			if (failure === "network") throw new TypeError("Network interrupted");
			if (failure === "server") return new Response(JSON.stringify({ error: { message: "Service interrupted" } }), { status: 503 });
			return response({});
		}
		return response({ id: "sent-message", threadId: "thread", attemptId: "attempt-1", deliveryStatus: "sent" });
	});
	await render(mode === "reply"
		? <ReplyCompose defaults={{ to: "reader@example.com", subject: "Re: Hello", quoteHtml: "" }} inReplyTo="parent" threadId="thread" onSent={() => { closed++; }} onDiscard={() => {}} />
		: <ComposeView draftId={mode === "draft" ? "saved-draft" : null} onClose={() => { closed++; }} />);
	await fill("To", "reader@example.com"); await click("Send");
	expect(button("Send").disabled).toBe(true); expect(button(mode === "compose" ? "Save as draft" : "Save draft").disabled).toBe(true);
	expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.disabled).toBe(true);
	expect(requests[0].requestId).toMatch(/^[\w-]{16,}$/); expect(closed).toBe(0);
	await click("Retry original request");
	expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(closed).toBe(1);
});

it("allows editing a rejected preflight request and gives the corrected send a new key", async () => {
	const requests: any[] = [];
	vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
		requests.push(JSON.parse(init.body as string));
		return requests.length === 1 ? new Response(JSON.stringify({ error: { message: "Invalid recipient" } }), { status: 400 }) : response({ id: "sent-message", threadId: "thread", deliveryStatus: "sent" });
	});
	await render(<ComposeView draftId={null} onClose={() => {}} />); await click("Send");
	expect(container.textContent).toContain("Invalid recipient"); expect(button("Send").disabled).toBe(false);
	await fill("To", "corrected@example.com"); await click("Send");
	expect(requests[1].to).toBe("corrected@example.com"); expect(requests[1].requestId).not.toBe(requests[0].requestId);
});

it("keeps the original unknown delivery protected when its recheck is rejected", async () => {
	const requests: any[] = [];
	vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
		requests.push(JSON.parse(init.body as string));
		if (requests.length === 1) throw new TypeError("Response lost");
		if (requests.length === 2) return new Response(JSON.stringify({ error: { message: "Session expired" } }), { status: 401 });
		return response({ id: "sent-message", threadId: "thread", deliveryStatus: "sent" });
	});
	await render(<ComposeView draftId={null} onClose={() => {}} />); await click("Send"); await click("Retry original request");
	expect(button("Send").disabled).toBe(true); expect(container.textContent).toContain("Session expired");
	await click("Retry original request"); expect(requests).toHaveLength(3); expect(requests[2]).toEqual(requests[0]);
});

it("uses the restored draft and a fresh request for an explicit retry after rejection", async () => {
	const requests: { path: string; body: any }[] = []; let closed = 0;
	vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
		requests.push({ path, body: JSON.parse(init.body as string) });
		return response(requests.length === 1
			? { id: null, threadId: null, attemptId: "rejected", deliveryStatus: "failed", draftId: "restored-draft", error: "Recipient rejected" }
			: { id: "sent-message", threadId: "thread", attemptId: "new-attempt", deliveryStatus: "sent" });
	});
	await render(<ComposeView draftId={null} onClose={() => { closed++; }} />);
	await click("Send");
	expect(closed).toBe(0); expect(container.textContent).toContain("Recipient rejected"); expect(button("Send").disabled).toBe(false);
	await fill("To", "corrected@example.com"); await click("Send");
	expect(requests[1].path).toContain("draft-send"); expect(requests[1].body.draftId).toBe("restored-draft");
	expect(requests[1].body.edits.to).toBe("corrected@example.com"); expect(requests[1].body.requestId).not.toBe(requests[0].body.requestId); expect(closed).toBe(1);
});

it("keeps an unavailable draft non-editable after a reload", async () => {
	vi.stubGlobal("fetch", async () => response({ items: [] }));
	await render(<ComposeView draftId="claimed-draft" onClose={() => {}} />);
	expect(container.textContent).toContain("Draft not found"); expect(button("Send").disabled).toBe(true); expect(button("Discard").disabled).toBe(true);
	expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.disabled).toBe(true);
});

function delivery(state = "uncertain", extra: Record<string, unknown> = {}) {
	return { attemptId: "attempt-1", messageId: "message-1", state, subject: "Delivery fixture", to: ["reader@example.com"], createdAt: "2026-09-16T00:00:00Z", updatedAt: "2026-09-16T00:00:00Z", canResolve: state === "uncertain", ...extra };
}
async function openOutbox() { window.history.replaceState({}, "", "/_emdash/admin/plugins/emdash-inbox?status=outbox"); await render(React.createElement(pages["/"] as React.ComponentType)); }

it("shows accepted delivery as pending and reconciles without submitting mail", async () => {
	const paths: string[] = [];
	vi.stubGlobal("fetch", async (path: string) => { paths.push(path); return response(path.endsWith("reconcile") ? { recovered: 1, restored: 0, uncertain: 0 } : { items: [delivery("accepted")], hasMore: false }); });
	await openOutbox();
	expect(container.textContent).toContain("Accepted — mailbox update pending");
	expect(container.textContent).not.toContain("Confirmed sent");
	await click("Refresh and reconcile");
	expect(paths.map((path) => path.split("/").slice(-2).join("/"))).toEqual(["deliveries/list", "deliveries/reconcile", "deliveries/list"]);
});

it.each(["failed", "restored"])("opens the preserved draft for a %s delivery without asking for a sent resolution", async (state) => {
	vi.stubGlobal("fetch", async () => response({ items: [delivery(state, { draftId: "editable-draft" })], hasMore: false }));
	await openOutbox();
	expect(container.querySelector('a[href*="compose=editable-draft"]')).not.toBeNull();
	expect([...container.querySelectorAll("button")].some(node => node.textContent === "Confirm sent")).toBe(false);
});

it("requires duplicate-risk acknowledgement before restoring an uncertain delivery", async () => {
	const resolutions: any[] = [];
	vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
		if (path.endsWith("resolve")) { resolutions.push(JSON.parse(init.body as string)); return response({ ok: true, draftId: "restored-draft" }); }
		return response({ items: resolutions.length ? [] : [delivery()], hasMore: false });
	});
	await openOutbox(); await click("Restore as draft");
	expect(button("Restore draft").disabled).toBe(true); await click("Restore draft"); expect(resolutions).toHaveLength(0);
	const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
	await React.act(async () => checkbox.click()); await click("Restore draft");
	expect(resolutions).toEqual([{ attemptId: "attempt-1", resolution: "restore", confirmDuplicateRisk: true }]);
	expect(container.textContent).toContain("Draft restored"); expect(container.querySelector('a[href*="compose=restored-draft"]')).not.toBeNull();
});

it("requires verification before recording sent and accepts an optional provider message ID", async () => {
	const resolutions: any[] = [];
	vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
		if (path.endsWith("resolve")) { resolutions.push(JSON.parse(init.body as string)); return response({ ok: true, id: "sent-message", threadId: "thread" }); }
		return response({ items: resolutions.length ? [] : [delivery()], hasMore: false });
	});
	await openOutbox(); await click("Confirm sent"); expect(button("Record as sent").disabled).toBe(true);
	await fill("Provider Message-ID (optional)", "<receipt@example.com>");
	await React.act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); await click("Record as sent");
	expect(resolutions).toEqual([{ attemptId: "attempt-1", resolution: "sent", providerMessageId: "<receipt@example.com>" }]);
	expect(container.textContent).toContain("Recorded as sent");
});

it("keeps resolution recoverable after an API failure and prevents same-tick duplicate actions", async () => {
	let finish!: (response: Response) => void; const pending = new Promise<Response>(resolve => { finish = resolve; }); let calls = 0;
	vi.stubGlobal("fetch", async (path: string) => {
		if (path.endsWith("resolve")) { calls++; return pending; }
		return response({ items: [delivery()], hasMore: false });
	});
	await openOutbox(); await click("Restore as draft");
	await React.act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
	await React.act(async () => { button("Restore draft").click(); button("Restore draft").click(); });
	expect(calls).toBe(1); expect(button("Restore draft").disabled).toBe(true);
	await React.act(async () => { finish(new Response(JSON.stringify({ error: { message: "Recovery interrupted" } }), { status: 503 })); });
	expect(container.textContent).toContain("Recovery interrupted"); expect(container.textContent).toContain("Delivery uncertain"); expect(button("Restore draft").disabled).toBe(false);
});

it("appends Outbox pages without duplicating moving attempts", async () => {
	const requests: any[] = [];
	vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string); requests.push(body);
		return response(body.cursor ? { items: [delivery("accepted"), delivery("sending", { attemptId: "attempt-2", subject: "Second delivery" })], hasMore: false } : { items: [delivery()], cursor: "outbox-page-2", hasMore: true });
	});
	await openOutbox(); await click("Load more deliveries");
	expect(requests[1].cursor).toBe("outbox-page-2"); expect(container.querySelectorAll("article")).toHaveLength(2);
	expect(container.textContent).toContain("Accepted — mailbox update pending"); expect(container.textContent).toContain("Second delivery");
	expect([...container.querySelectorAll("button")].some(node => node.textContent === "Load more deliveries")).toBe(false);
});
