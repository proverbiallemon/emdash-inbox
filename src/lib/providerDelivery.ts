import { PluginRouteError } from "emdash";
import type { MessageDoc } from "../index";

export type ProviderStatus = "delivered" | "deferred" | "bounced" | "failed" | "rejected" | "complained";
export interface DeliveryEventScope { accountId: string; zoneId: string; domain: string }
export interface ProviderDelivery {
	messageId: string; recipient: string; status: ProviderStatus; at: string;
	eventId: string; source: "cloudflare-event" | "cloudflare-analytics";
	reason?: string; smtpCode?: string;
}
export interface RecipientDelivery { recipient: string; status: ProviderStatus | "unconfirmed"; at?: string; reason?: string; smtpCode?: string }
export interface DeliverySummary { recipients: RecipientDelivery[] }
interface Collection {
	get(id: string): Promise<ProviderDelivery | null>;
	getVersioned(id: string): Promise<{ value: ProviderDelivery; revision: string } | null>;
	compareAndSet(id: string, revision: string | null, value: ProviderDelivery): Promise<{ applied: boolean }>;
}
export interface DeliveryEventContext { storage: { providerDeliveries: Collection } }
const statuses = new Set<ProviderStatus>(["delivered", "deferred", "bounced", "failed", "rejected", "complained"]);
const priority: Record<ProviderStatus, number> = { deferred: 0, delivered: 1, failed: 2, rejected: 3, bounced: 4, complained: 5 };

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown, max = 998): string {
	return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : "";
}
// Provider IDs are opaque, but the email API may wrap the same ID in <>.
export function providerMessageKey(value: string): string { return value.trim().replace(/^<([^<>]+)>$/, "$1"); }
export async function providerDeliveryKey(messageId: string, recipient: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([providerMessageKey(messageId), recipient.trim().toLowerCase()])));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function parseProviderEvent(input: unknown, scope?: DeliveryEventScope): ProviderDelivery {
	if (!scope) throw PluginRouteError.forbidden("Delivery events are not configured.");
	const event = object(input), source = object(event.source), metadata = object(event.metadata), payload = object(event.payload);
	const delivery = object(payload.delivery);
	const status = delivery.status as ProviderStatus;
	if (source.type !== "email.sending" || source.zoneId !== scope.zoneId || source.domain !== scope.domain || metadata.accountId !== scope.accountId) throw PluginRouteError.forbidden("Unexpected delivery event source.");
	if (!statuses.has(status) || event.type !== `cf.email.sending.message.${status}` || payload.terminal !== (status !== "deferred") || metadata.eventSchemaVersion !== 1) throw PluginRouteError.badRequest("Unsupported delivery event.");
	const messageId = string(payload.messageId), recipient = string(payload.recipient, 320).toLowerCase(), eventId = string(payload.eventId, 200), timestamp = string(metadata.eventTimestamp, 40);
	if (!messageId || !/^[^\s@]+@[^\s@]+$/.test(recipient) || !eventId || !/^\d{4}-\d{2}-\d{2}T/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) > Date.now() + 300_000) throw PluginRouteError.badRequest("Incomplete delivery event.");
	const reason = string(object(payload.bounce).reason, 2000) || string(object(payload.failure).reason, 2000) || string(object(payload.rejection).detail, 2000) || string(object(payload.rejection).reason, 2000) || string(delivery.smtpResponse, 2000) || string(object(payload.complaint).type, 2000);
	return { messageId: providerMessageKey(messageId), recipient, status, eventId, at: new Date(timestamp).toISOString(), source: "cloudflare-event", ...(reason ? { reason } : {}), ...(string(delivery.smtpStatusCode, 10) ? { smtpCode: string(delivery.smtpStatusCode, 10) } : {}) };
}

/** Independent of send/recovery state: a provider event can never resend mail. */
export async function recordProviderEvent(ctx: DeliveryEventContext, input: unknown, scope?: DeliveryEventScope) {
	const event = parseProviderEvent(input, scope);
	const id = await providerDeliveryKey(event.messageId, event.recipient);
	for (let attempt = 0; attempt < 8; attempt++) {
		const current = await ctx.storage.providerDeliveries.getVersioned(id);
		if (current) {
			const old = current.value;
			// Delivery queues can duplicate or reorder events. Never regress a
			// terminal result to a temporary deferral or erase a spam complaint.
			if (old.eventId === event.eventId || old.status === "complained" || (old.status !== "deferred" && event.status === "deferred") || old.at > event.at || (old.at === event.at && priority[old.status] >= priority[event.status])) return { ok: true, changed: false };
		}
		if ((await ctx.storage.providerDeliveries.compareAndSet(id, current?.revision ?? null, event)).applied) return { ok: true, changed: true };
	}
	throw new Error("Delivery status changed repeatedly; retry the event.");
}

/** Lookups join by provider ID and recipient, never subject or conversation. */
export async function readProviderDelivery(ctx: DeliveryEventContext, message: Pick<MessageDoc, "messageId" | "transportMessageId" | "direction" | "to" | "toAll" | "cc" | "bcc">, redactCopies = false): Promise<DeliverySummary | null> {
	if (message.direction !== "outbound") return null;
	const recipients = [...new Set([...(message.toAll ?? [message.to]), ...(message.cc ?? []), ...(message.bcc ?? [])].map(address => address.trim().toLowerCase()).filter(Boolean))];
	const messageId = message.transportMessageId ?? message.messageId;
	const visible = new Set((message.toAll ?? [message.to]).map(address => address.trim().toLowerCase()));
	return { recipients: await Promise.all(recipients.map(async (recipient, index) => {
		const event = await ctx.storage.providerDeliveries.get(await providerDeliveryKey(messageId, recipient));
		const hidden = redactCopies && !visible.has(recipient);
		const label = hidden ? `Copy recipient ${index + 1}` : recipient;
		return event ? { recipient: label, status: event.status, at: event.at, ...(!hidden ? { reason: event.reason, smtpCode: event.smtpCode } : {}) } : { recipient: label, status: "unconfirmed" as const };
	})) };
}
