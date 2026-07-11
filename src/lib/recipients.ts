import { z } from "zod";

/**
 * Recipient math for compose / reply-all. Pure — no ctx, no I/O.
 */

const emailSchema = z.email();

export interface ReplyAllSource {
	direction: "inbound" | "outbound";
	from: string;
	to: string;
	toAll?: string[];
	cc?: string[];
}

export type NormalizeResult =
	| { ok: true; value: string[] }
	| { ok: false; error: string };

/**
 * Accepts a single string (possibly comma-separated), an array of strings,
 * or undefined. Returns trimmed, per-address-validated, case-insensitively
 * deduped addresses (first casing wins). Empty input is ok:true with [] —
 * callers decide whether an empty list is an error for their field.
 */
export function normalizeRecipients(input: string | string[] | undefined): NormalizeResult {
	if (input === undefined) return { ok: true, value: [] };

	let parts: unknown[];
	if (typeof input === "string") {
		parts = input.split(",").map((s) => s.trim()).filter((s) => s !== "");
	} else if (Array.isArray(input)) {
		parts = input;
	} else {
		return { ok: false, error: "recipients must be a string or an array of strings" };
	}

	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of parts) {
		if (typeof part !== "string") {
			return { ok: false, error: `invalid recipient: ${JSON.stringify(part)} (not a string)` };
		}
		const addr = part.trim();
		if (addr === "") continue;
		if (!emailSchema.safeParse(addr).success) {
			return { ok: false, error: `invalid email address: "${addr}"` };
		}
		const key = addr.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(addr);
	}
	return { ok: true, value: out };
}

/**
 * Reply-all recipient derivation from the thread's latest inbound message:
 * sender goes in `to`; the original to + cc (minus our own sender address,
 * minus the reply-to sender, deduped) go in `cc`. The "minus my address"
 * filter is intentionally server-side (spec §Shared core); the client may
 * also pre-filter for display, but this is the enforcement point.
 */
export function deriveReplyAll(
	latest: ReplyAllSource,
	senderAddress: string,
): { to: string[]; cc: string[] } {
	const self = senderAddress.trim().toLowerCase();
	const replyTo = latest.from;

	const seen = new Set<string>([replyTo.toLowerCase()]);
	if (self !== "") seen.add(self);

	const cc: string[] = [];
	const candidates = [...(latest.toAll ?? [latest.to]), ...(latest.cc ?? [])];
	for (const addr of candidates) {
		const trimmed = addr.trim();
		if (trimmed === "") continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		cc.push(trimmed);
	}

	return { to: [replyTo], cc };
}
