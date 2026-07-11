import type { Address } from "postal-mime";

/**
 * Extract ordered, non-empty email addresses from a postal-mime `to`/`cc`
 * field (M8 inbound persistence gap fix).
 *
 * postal-mime's `Address` is a union: a `Mailbox` (`{ name, address }`) or a
 * mailing-list `group` entry (`{ name, group: Mailbox[] }`, `address`
 * undefined). We only care about individually-addressed recipients here, so
 * group entries — and any entry with a missing/blank address — are skipped
 * rather than recursed into.
 */
export function extractAddresses(addresses: Address[] | undefined): string[] {
	if (!addresses) return [];
	const out: string[] = [];
	for (const entry of addresses) {
		const addr = entry.address;
		if (!addr) continue;
		const trimmed = addr.trim();
		if (trimmed === "") continue;
		out.push(trimmed);
	}
	return out;
}
