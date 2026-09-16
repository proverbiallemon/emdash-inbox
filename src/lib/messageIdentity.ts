/** Accept a complete RFC message identifier; never guess a provider's domain. */
export function normalizeMessageId(value: string | undefined): string | null {
	if (!value) return null;
	const id = value.startsWith("<") ? value : `<${value}>`;
	return id.length <= 2048 && /^<[^<>\s@]+@[^<>\s@]+>$/.test(id) ? id : null;
}

/** Cloudflare limits individual custom header values to 2048 characters. */
export function replyReferences(ancestors: string[], parent: string): string[] {
	const parentId = normalizeMessageId(parent);
	const refs = [...new Set(ancestors.map(normalizeMessageId).filter((id): id is string => id !== null && id !== parentId))];
	if (parentId) refs.push(parentId);
	while (refs.join(" ").length > 2048) refs.shift();
	return refs;
}
