// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookPipeline, PluginStorageRepository } from "emdash";
import { createNativeHost } from "./helpers/nativeHost";
import { createPlugin } from "../src/index";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: { EMAIL: transport } }));

it("registers all inbox operations as private, permission-gated native MCP tools", () => {
	const plugin = createPlugin();
	expect(Object.keys(plugin.mcp?.tools ?? {})).toHaveLength(20);
	for (const tool of Object.values(plugin.mcp!.tools)) {
		const route = plugin.routes[tool.route];
		expect(route.public).not.toBe(true);
		expect(route.permission).toBe("plugins:manage");
		expect(route.input).toBe(tool.input);
	}
	for (const name of ["deliveries/list", "deliveries/reconcile", "deliveries/resolve"]) {
		expect(plugin.routes[name].public).not.toBe(true);
		expect(plugin.routes[name].permission).toBe("plugins:manage");
	}
});

describe("EmDash native host", () => {
	let host: Awaited<ReturnType<typeof createNativeHost>>;
	beforeEach(async () => {
		transport.send.mockReset().mockResolvedValue({ messageId: "<delivery-1@cloudflare.example>" });
		host = await createNativeHost();
	});
	afterEach(async () => { vi.restoreAllMocks(); await host?.close(); });

	async function deliverSystemEmail() {
		const hooks = new HookPipeline(host.manager.getActivePlugins(), { db: host.db });
		hooks.setExclusiveSelection("email:deliver", host.plugin.id);
		return hooks.invokeExclusiveHook("email:deliver", {
			message: { to: "recipient@example.com", subject: "System delivery", text: "System message body" },
			source: "system",
		});
	}

	it("does not report a core email hook failure after provider acceptance when sent projection fails", async () => {
		const write = PluginStorageRepository.prototype.compareAndSet;
		vi.spyOn(PluginStorageRepository.prototype, "compareAndSet").mockImplementation(async function (
			this: PluginStorageRepository, ...args: Parameters<typeof write>
		) {
			if ((args[2] as any).status === "done") throw new Error("Sent projection unavailable");
			return write.apply(this, args);
		});
		const delivered = await deliverSystemEmail();
		expect(delivered?.error).toBeUndefined();
		expect(delivered?.pluginId).toBe(host.plugin.id);
		expect(transport.send).toHaveBeenCalledOnce();
		expect((await host.messages.query({ where: { status: "outbox" } })).items).toHaveLength(1);
		const journal = new PluginStorageRepository(host.db, host.plugin.id, "deliveries", ["state"]);
		expect((await journal.query({})).items[0].data).toMatchObject({ state: "accepted", receipt: { messageId: "<delivery-1@cloudflare.example>" } });
	});

	it.each([
		{ code: "E_VALIDATION_ERROR", state: "failed", status: "draft" },
		{ code: undefined, state: "uncertain", status: "outbox" },
	])("reports $state through the core email hook without claiming successful delivery", async ({ code, state, status }) => {
		transport.send.mockRejectedValueOnce(Object.assign(new Error("Provider response unavailable"), code ? { code } : {}));
		const delivered = await deliverSystemEmail();
		expect(delivered?.pluginId).toBe(host.plugin.id);
		expect(delivered?.error).toBeInstanceOf(Error);
		expect(delivered?.error?.message).toMatch(/rejected|Outbox review/i);
		expect(transport.send).toHaveBeenCalledOnce();
		expect((await host.messages.query({ where: { status } })).items).toHaveLength(1);
		const journal = new PluginStorageRepository(host.db, host.plugin.id, "deliveries", ["state"]);
		expect((await journal.query({})).items[0].data).toMatchObject({ state });
	});

	it("joins a recipient's reply to the outbound conversation using its delivered Message-ID", async () => {
		const sent = await host.request("messages/compose", { to: "recipient@example.com", subject: "Roundtrip", text: "Hello" });
		expect(sent.success, JSON.stringify(sent)).toBe(true);
		const outbound = await host.messages.get((sent.data as { id: string }).id);
		expect(outbound?.messageId).toBe("<delivery-1@cloudflare.example>");
		const rawMime = ["From: recipient@example.com", "To: owner@example.com", "Subject: Re: Roundtrip", "Message-ID: <reply-1@example.com>", "In-Reply-To: <delivery-1@cloudflare.example>", "References: <delivery-1@cloudflare.example>", "", "Reply"].join("\r\n");
		const received = await host.request("inbound", { rawMime }, { "X-Inbound-Secret": "test-only-inbound-secret" });
		expect(received.success).toBe(true);
		const inbound = await host.messages.get((received.data as { id: string }).id);
		expect(inbound?.threadId).toBe(outbound?.threadId);
	});

	it("carries the References chain when replying through native MCP", async () => {
		const rawMime = ["From: recipient@example.com", "To: owner@example.com", "Subject: Hello", "Message-ID: <parent@example.com>", "References: <root@example.com>", "", "Hello"].join("\r\n");
		await host.request("inbound", { rawMime }, { "X-Inbound-Secret": "test-only-inbound-secret" });
		const reply = await host.request("mcp/reply_to_thread", { threadId: "<parent@example.com>", text: "My reply" });
		expect(reply.success).toBe(true);
		expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ headers: {
			"In-Reply-To": "<parent@example.com>", "References": "<root@example.com> <parent@example.com>",
		} }));
	});

	it.each([true, false])("replies to HTML email without a browser DOM (quoteOriginal=%s)", async (quoteOriginal) => {
		const rawMime = [
			"From: recipient@example.com", "To: owner@example.com", "Subject: HTML message", "Message-ID: <html@example.com>",
			'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="parts"', "",
			"--parts", "Content-Type: text/plain; charset=utf-8", "", "Original <text> & more",
			"--parts", "Content-Type: text/html; charset=utf-8", "", '<p>Original <strong>text</strong> &amp; more</p><img src="https://tracker.example/pixel">', "--parts--",
		].join("\r\n");
		const received = await host.request("inbound", { rawMime }, { "X-Inbound-Secret": "test-only-inbound-secret" });
		expect(received.success).toBe(true);
		const reply = await host.request("mcp/reply_to_thread", { threadId: "<html@example.com>", text: "Reply", quoteOriginal });
		expect(reply.success, JSON.stringify(reply)).toBe(true);
		const html = transport.send.mock.calls[0][0].html;
		expect(html).not.toContain("tracker.example");
		if (quoteOriginal) expect(html).toContain("Original &lt;text&gt; &amp; more");
		else expect(html).toBe("<p>Reply</p>");
	});

	it("identifies an HTML-only original instead of silently producing an empty quote", async () => {
		const rawMime = "From: recipient@example.com\r\nMessage-ID: <html-only@example.com>\r\nContent-Type: text/html\r\n\r\n<p>HTML-only original</p>";
		await host.request("inbound", { rawMime }, { "X-Inbound-Secret": "test-only-inbound-secret" });
		const reply = await host.request("mcp/reply_to_thread", { threadId: "<html-only@example.com>", text: "Reply" });
		expect(reply.success).toBe(true);
		expect(transport.send.mock.calls[0][0].html).toContain("[Original HTML message omitted from this quote.]");
	});

	it("rejects malformed native MCP inputs before storing a draft", async () => {
		const result = await host.request("mcp/save_draft", { to: 42, subject: "Bad input" });
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("VALIDATION_ERROR");
		expect((await host.messages.query({ where: { status: "draft" } })).items).toHaveLength(0);
	});

	it("rejects inbound mail with an invalid webhook secret", async () => {
		const result = await host.request("inbound", { rawMime: "From: bad@example.com\r\n\r\nBody" });
		expect(result.status).toBe(401);
		expect((await host.messages.query({})).items).toHaveLength(0);
	});

	it("wakes snoozed messages through the host cron hook", async () => {
		const received = await host.request("inbound", { rawMime: "From: recipient@example.com\r\nMessage-ID: <cron@example.com>\r\n\r\nBody" }, { "X-Inbound-Secret": "test-only-inbound-secret" });
		const id = (received.data as { id: string }).id;
		const message = (await host.messages.get(id))!;
		await host.messages.put(id, { ...message, status: "snoozed", snoozeUntil: "2020-01-01T00:00:00.000Z" });
		await host.manager.invokeCronHook(host.plugin.id, { name: "wake-snoozed-messages", scheduledAt: new Date().toISOString() });
		expect(await host.messages.get(id)).toMatchObject({ status: "inbox", snoozeUntil: null });
	});
});
