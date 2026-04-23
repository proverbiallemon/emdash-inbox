import type { MessageDoc } from "../index";

export interface ParticipantChip {
	label: string;
	initial: string;
	isYou: boolean;
}

/**
 * Derive the chip list for a thread's participants. Chips appear in first-
 * seen order; same counterparty appearing in multiple messages dedupes to
 * one chip. Outbound messages contribute the "you" chip; inbound messages
 * contribute the sender's local-part (the bit before @).
 *
 * Address comparison is case-insensitive — "Alice@Example.com" and
 * "alice@example.com" are the same person.
 */
export function deriveParticipantChips(
	messages: MessageDoc[],
	senderAddress: string,
): ParticipantChip[] {
	const seen = new Set<string>();
	const chips: ParticipantChip[] = [];
	const senderLc = senderAddress.toLowerCase();

	for (const m of messages) {
		// Treat outbound messages OR messages whose `from` matches our configured
		// sender as "you". The double check handles edge cases where direction
		// might lag behind sender-config changes during dogfooding.
		const isYou = m.direction === "outbound" || m.from.toLowerCase() === senderLc;

		if (isYou) {
			if (seen.has("__you__")) continue;
			seen.add("__you__");
			// Derive from senderAddress local-part so the chip matches EmDash's
			// top-right user-avatar treatment (initial + name) instead of the
			// generic "Y you" placeholder. Falls back to "you"/"Y" only when
			// senderAddress is empty (settings not configured yet).
			const senderLocal = senderLc.split("@")[0] || "";
			const label = senderLocal || "you";
			const initial = (senderLocal.charAt(0) || "y").toUpperCase();
			chips.push({ label, initial, isYou: true });
			continue;
		}

		const addrLc = m.from.toLowerCase();
		if (seen.has(addrLc)) continue;
		seen.add(addrLc);

		const localPart = addrLc.split("@")[0] || addrLc;
		const initial = localPart.charAt(0).toUpperCase() || "?";
		chips.push({ label: localPart, initial, isYou: false });
	}

	return chips;
}
