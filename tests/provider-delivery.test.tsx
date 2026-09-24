// @vitest-environment node
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginStorageRepository } from "emdash";
import { createNativeHost } from "./helpers/nativeHost";
import { createPlugin } from "../src/index";
import { parseProviderEvent, providerDeliveryKey, readProviderDelivery, recordProviderEvent, type ProviderStatus, type ProviderDelivery } from "../src/lib/providerDelivery";
import { ProviderDeliveryStatus } from "../src/components/ProviderDeliveryStatus";

const scope = { accountId: "account", zoneId: "zone", domain: "example.com" };
const event = (status: ProviderStatus = "delivered", at = "2026-09-20T12:00:00Z", recipient = "reader@example.net") => ({
	type: `cf.email.sending.message.${status}`, source: { type: "email.sending", zoneId: scope.zoneId, domain: scope.domain },
	metadata: { accountId: scope.accountId, eventSchemaVersion: 1, eventTimestamp: at },
	payload: { eventId: `${status}-${at}`, messageId: "<message@example.com>", recipient, terminal: status !== "deferred", delivery: { status, smtpResponse: status === "delivered" ? "250 OK" : "550 Unknown mailbox" } },
});
let host: Awaited<ReturnType<typeof createNativeHost>>;
let ctx: { storage: { providerDeliveries: PluginStorageRepository<ProviderDelivery> } };
beforeEach(async () => { host = await createNativeHost({ deliveryEvents: scope }); ctx = { storage: { providerDeliveries: new PluginStorageRepository(host.db, host.plugin.id, "providerDeliveries", ["messageId"]) } }; });
afterEach(async () => { vi.restoreAllMocks(); await host?.close(); });

it("records events through native route dispatch using descriptor options", async () => {
	const result = await host.request("delivery-events/record", event());
	expect(result).toMatchObject({ success: true, data: { ok: true, changed: true } });
	expect((await ctx.storage.providerDeliveries.get(await providerDeliveryKey("message@example.com", "reader@example.net")))?.status).toBe("delivered");
});

it("persists an event before the sent row exists and joins only the matching provider ID and recipient", async () => {
	await recordProviderEvent(ctx, event(), scope);
	const message = { messageId: "draft", transportMessageId: "message@example.com", direction: "outbound" as const, to: "Reader@example.net", cc: ["cc@example.net"], bcc: ["private@example.net"] };
	expect((await readProviderDelivery(ctx, message))?.recipients.map(r => r.status)).toEqual(["delivered", "unconfirmed", "unconfirmed"]);
	expect((await readProviderDelivery(ctx, { ...message, transportMessageId: "other@example.com" }))?.recipients.every(r => r.status === "unconfirmed")).toBe(true);
	expect(await readProviderDelivery(ctx, { ...message, direction: "inbound" })).toBeNull();
	expect(JSON.stringify(await readProviderDelivery(ctx, message, true))).not.toContain("private@example.net");
	expect((await host.messages.query({ limit: 10 })).items).toHaveLength(0);
});

it("handles duplicates, out-of-order deferrals, bounces, and complaints without regressing terminal results", async () => {
	expect((await recordProviderEvent(ctx, event(), scope)).changed).toBe(true);
	expect((await recordProviderEvent(ctx, event(), scope)).changed).toBe(false);
	await recordProviderEvent(ctx, event("deferred", "2026-09-20T13:00:00Z"), scope);
	const id = await providerDeliveryKey("message@example.com", "reader@example.net");
	expect((await ctx.storage.providerDeliveries.get(id))?.status).toBe("delivered");
	await recordProviderEvent(ctx, event("bounced", "2026-09-20T14:00:00Z"), scope);
	await recordProviderEvent(ctx, event("delivered", "2026-09-20T12:30:00Z"), scope);
	expect((await ctx.storage.providerDeliveries.get(id))?.status).toBe("bounced");
	await recordProviderEvent(ctx, event("complained", "2026-09-20T15:00:00Z"), scope);
	await recordProviderEvent(ctx, event("delivered", "2026-09-20T16:00:00Z"), scope);
	expect((await ctx.storage.providerDeliveries.get(id))?.status).toBe("complained");
});

it("uses CAS across concurrent events and retries after a lost write acknowledgment", async () => {
	await Promise.all([recordProviderEvent(ctx, event("deferred"), scope), recordProviderEvent(ctx, event("delivered", "2026-09-20T13:00:00Z"), scope)]);
	const save = ctx.storage.providerDeliveries.compareAndSet.bind(ctx.storage.providerDeliveries);
	vi.spyOn(ctx.storage.providerDeliveries, "compareAndSet").mockImplementationOnce(async (...args) => { await save(...args); throw new Error("lost ack"); });
	await expect(recordProviderEvent(ctx, event("bounced", "2026-09-20T14:00:00Z"), scope)).rejects.toThrow("lost ack");
	expect((await recordProviderEvent(ctx, event("bounced", "2026-09-20T14:00:00Z"), scope)).changed).toBe(false);
});

it("rejects unconfigured, foreign, malformed, unsupported and future-dated events", () => {
	expect(() => parseProviderEvent(event())).toThrow();
	const changes = [{ source: { ...event().source, domain: "other.com" } }, { metadata: { ...event().metadata, accountId: "other" } }, { metadata: { ...event().metadata, eventSchemaVersion: 2 } }, { metadata: { ...event().metadata, eventTimestamp: "bad" } }, { metadata: { ...event().metadata, eventTimestamp: "2099-01-01T00:00:00Z" } }, { payload: { ...event().payload, terminal: false } }, { payload: { ...event().payload, recipient: "bad" } }, { type: "cf.email.routing.delivered" }];
	for (const change of changes) expect(() => parseProviderEvent({ ...event(), ...change }, scope)).toThrow();
	expect(createPlugin({ deliveryEvents: scope }).routes["delivery-events/record"].permission).toBe("plugins:manage");
});

it("renders mixed recipient results, escapes SMTP text and explains what delivered means", () => {
	const html = renderToStaticMarkup(<ProviderDeliveryStatus delivery={{ recipients: [{ recipient: "a@example.net", status: "delivered" }, { recipient: "b@example.net", status: "bounced", reason: "<script>bad</script>" }] }} />);
	expect(html).toContain("1/2 accepted by recipient servers");
	expect(html).toContain("Bounced"); expect(html).toContain("does not confirm inbox placement or reading");
	expect(html).not.toContain("<script>");
});
