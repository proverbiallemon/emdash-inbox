export interface ParentInfo {
	messageId: string;
	threadId: string | null;
}

/**
 * Derive threadId + stored inReplyTo for a message.
 *
 * Pure function; caller provides parentLookup so this module has no storage
 * dependency. Shared between persistInbound, persistOutbound, and the
 * ensureMigrations backfill.
 *
 * Behavior:
 *   1. Try the inReplyToHeader first (most authoritative for reply).
 *   2. If that fails, walk references right-to-left (most recent ancestor first).
 *   3. If any ancestor resolves, inherit parent.threadId — with fallback to
 *      parent.messageId if parent.threadId is still null (covers the
 *      race where backfill processes child before parent).
 *   4. If nothing resolves, the message becomes its own thread root.
 *
 * inReplyTo return value:
 *   - If inReplyToHeader was set, echo it (preserved for orphan retry even
 *     when the lookup missed).
 *   - Else if walking references found a parent, return that reference.
 *   - Else null.
 */
export function deriveThreadInfo(
	messageId: string,
	inReplyToHeader: string | null,
	references: string[],
	parentLookup: (msgId: string) => ParentInfo | null,
): { threadId: string; inReplyTo: string | null } {
	if (inReplyToHeader) {
		const parent = parentLookup(inReplyToHeader);
		if (parent) {
			return {
				threadId: parent.threadId ?? parent.messageId,
				inReplyTo: inReplyToHeader,
			};
		}
	}

	for (let i = references.length - 1; i >= 0; i--) {
		const ref = references[i];
		const parent = parentLookup(ref);
		if (parent) {
			return {
				threadId: parent.threadId ?? parent.messageId,
				inReplyTo: inReplyToHeader ?? ref,
			};
		}
	}

	return {
		threadId: messageId,
		inReplyTo: inReplyToHeader,
	};
}
