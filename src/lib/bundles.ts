import { addressParser } from "postal-mime";
import { z } from "zod";
import type { MessageDoc } from "../index";
export const BUNDLE_IDS = ["orders", "shipping", "commissions", "fans", "promos", "updates"] as const;
export type BundleId = typeof BUNDLE_IDS[number];
export interface BundleAssignment {
    bundle: BundleId | null;
    source: "manual" | "sender" | "builtin" | "none";
    ruleId?: string;
    sender?: string;
}
export interface BundleEvidence {
    version: 1;
    /** Unlike a successful no-match, failure supersedes older automatic evidence. */
    failed?: true;
    assignment: BundleAssignment;
}
export interface BundleRule {
    version: 1;
    id: string;
    sender: string;
    bundle: BundleId | null;
}
export interface BundleOverride {
    version: 1;
    threadId: string;
    bundle: BundleId | null;
    dirty: boolean;
}
export const BUNDLE_DEFINITIONS: ReadonlyArray<{
    id: BundleId;
    title: string;
    description: string;
}> = [
    { id: "orders", title: "Orders", description: "Purchase confirmations and receipts" },
    { id: "shipping", title: "Shipping", description: "Dispatch, tracking and delivery notices" },
    { id: "commissions", title: "Commissions", description: "Correspondence from configured project addresses" },
    { id: "fans", title: "Fans", description: "Correspondence from configured supporter addresses" },
    { id: "promos", title: "Promos", description: "Clear offers and discounts" },
    { id: "updates", title: "Updates", description: "Newsletters and service notifications" },
];
export function isBundleId(value: unknown): value is BundleId { return BUNDLE_IDS.includes(value as BundleId); }
export function validEnabledBundles(value: unknown): value is BundleId[] {
    return Array.isArray(value) && value.every(isBundleId) && new Set(value).size === value.length;
}
/** Parse exactly one mailbox; never match text in a display name or a domain. */
export function canonicalSender(value: string): string | null {
    if (typeof value !== "string" || /[\r\n]/.test(value))
        return null;
    try {
        const parsed = addressParser(value);
        if (parsed.length !== 1 || !parsed[0].address || parsed[0].group)
            return null;
        const address = parsed[0].address.trim().toLowerCase();
        return z.email().safeParse(address).success ? address : null;
    }
    catch {
        return null;
    }
}
export const NO_BUNDLE: BundleAssignment = { bundle: null, source: "none" };
export function builtinAssignment(message: Pick<MessageDoc, "direction" | "status" | "subject" | "from">): BundleAssignment {
    if (message.direction !== "inbound" || message.status === "draft" || message.status === "outbox")
        return { ...NO_BUNDLE };
    const subject = (message.subject ?? "").toLowerCase();
    let bundle: BundleId | null = null;
    if (/\b(?:your (?:order|package|shipment) (?:(?:has (?:shipped|arrived|been dispatched)|was delivered)|is (?:on (?:its|the) way|out for delivery))|shipping confirmation|delivery confirmation|tracking (?:number|update))\b/.test(subject))
        bundle = "shipping";
    else if (/\b(?:order confirmation|payment receipt|your receipt|receipt for|thank you for your (?:order|purchase))\b/.test(subject))
        bundle = "orders";
    else if (/\b(?:\d{1,2}% off|save \d{1,2}%|limited.time offer|exclusive discount)\b/.test(subject))
        bundle = "promos";
    else if (/\b(?:newsletter|weekly digest|monthly digest|security alert|password (?:changed|reset)|service notification)\b/.test(subject))
        bundle = "updates";
    return bundle ? { bundle, source: "builtin", ruleId: `builtin:${bundle}:1` } : { ...NO_BUNDLE };
}
/** Invalid persisted evidence is a failure, not an ordinary acknowledgement with no match. */
export function bundleClassificationFailed(message: MessageDoc): boolean {
    if (message.direction !== "inbound" || message.status === "draft" || message.status === "outbox")
        return false;
    const evidence = message.bundleEvidence;
    if (evidence === undefined)
        return false;
    const assignment = evidence?.assignment;
    return !evidence || evidence.version !== 1 || evidence.failed !== undefined || !assignment ||
        (assignment.bundle !== null && !isBundleId(assignment.bundle)) ||
        !["sender", "builtin", "none"].includes(assignment.source);
}
/** Ingested evidence is immutable. Legacy rows use built-ins without consulting current rules. */
export function messageAssignment(message: MessageDoc): BundleAssignment {
    if (message.direction !== "inbound" || message.status === "draft" || message.status === "outbox" || bundleClassificationFailed(message))
        return { ...NO_BUNDLE };
    return message.bundleEvidence?.assignment ?? builtinAssignment(message);
}
export function classifyThread(messages: MessageDoc[], override?: Pick<BundleOverride, "bundle"> | null): BundleAssignment {
    if (override)
        return { bundle: override.bundle, source: "manual" };
    const incoming = messages.filter(m => m.direction === "inbound" && m.status !== "draft" && m.status !== "outbox").sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    for (let i = incoming.length - 1; i >= 0; i--) {
        const match = messageAssignment(incoming[i]);
        if (match.source !== "none" || bundleClassificationFailed(incoming[i]))
            return match;
    }
    return { ...NO_BUNDLE };
}
