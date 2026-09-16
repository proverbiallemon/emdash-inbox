/** Pure mail metadata shared by API serializers and client type imports. */
export interface StoredAttachment {
	id: string;
	objectKey: string;
	filename: string;
	mimeType: string;
	size: number;
	sha256: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}
export type PublicAttachment = Omit<StoredAttachment, "objectKey">;

export function publicAttachment(attachment: StoredAttachment): PublicAttachment {
	const { id, filename, mimeType, size, sha256, disposition, contentId } = attachment;
	return { id, filename, mimeType, size, sha256, disposition, ...(contentId ? { contentId } : {}) };
}

type InternalMessageFields = "deliveryProjected" | "deliveryAttemptId" | "deliveryFingerprint" | "deliveryCreatedAt" | "bodyRaw" | "rawObjectKey" | "objectKey" | "attachments" | "indexDirty" | "indexPreviousThreadIds" | "indexSchemaVersion" | "messageKey";
export function publicMessage<T extends object>(doc: T): Omit<T, InternalMessageFields> & { attachments?: PublicAttachment[] } {
	const {
		deliveryProjected: _projected, deliveryAttemptId: _attempt, deliveryFingerprint: _fingerprint, deliveryCreatedAt: _deliveryCreatedAt,
		bodyRaw: _raw, rawObjectKey: _rawKey, objectKey: _key, attachments,
		indexDirty: _dirty, indexPreviousThreadIds: _previous, indexSchemaVersion: _schema, messageKey: _messageKey,
		...rest
	} = doc as T & Record<InternalMessageFields, unknown> & { attachments?: StoredAttachment[] };
	return { ...rest, ...(attachments ? { attachments: attachments.map(publicAttachment) } : {}) };
}
