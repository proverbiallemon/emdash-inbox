import type { StorageCollection } from "emdash";
import type { MessageDoc } from "../index";
import { isDraftRow, type StatusFilter } from "./threadSummary";
import { deriveParticipantChips } from "./participantChips";
import { deriveThreadInfo } from "./threadDerive";
import { publicMessage } from "./attachments";

export interface MessageRow<T = MessageDoc> { id: string; data: T }
type QueryOptions<T> = NonNullable<Parameters<StorageCollection<T>["query"]>[0]>;

/** Iterate the host's immutable created-at/id cursor; its real page cap is 100. */
export async function allRows<T>(
	collection: StorageCollection<T>,
	options: Pick<QueryOptions<T>, "where"> = {},
): Promise<MessageRow<T>[]> {
	const rows: MessageRow<T>[] = [];
	let cursor: string | undefined;
	do {
		const page = await collection.query({ ...options, limit: 100, cursor });
		rows.push(...page.items);
		if (!page.hasMore) break;
		if (!page.cursor || page.cursor === cursor) throw new Error("Storage returned an invalid continuation");
		cursor = page.cursor;
	} while (cursor);
	return rows;
}

function chronological(a: MessageRow<Pick<MessageDoc, "receivedAt">>, b: MessageRow<Pick<MessageDoc, "receivedAt">>): number {
	return a.data.receivedAt.localeCompare(b.data.receivedAt) || a.id.localeCompare(b.id);
}

export async function loadThreadRows(ctx: any, threadId: string): Promise<MessageRow[]> {
	const rows = await allRows<MessageDoc>(ctx.storage.messages, { where: { threadId } });
	return rows.filter((row) => !isDraftRow(row)).sort(chronological);
}

export const mailboxMessageIndexes = ["indexDirty", "messageKey"];
export const mailboxCollections = {
	threads: { indexes: ["status", "listKey", "snoozeKey", ["status", "listKey"], ["status", "snoozeKey"]] },
	searchDocuments: { indexes: ["messageKey"] },
};
export const MAILBOX_MIGRATION_KEY = "state:mailbox-index:v1";
const INDEX_VERSION = 1;
const MIGRATION_PAGE_SIZE = 50;
const REPAIR_MESSAGE_LIMIT = 50;
const MAX_CAS_ATTEMPTS = 8;
const SEARCH_SCAN_LIMIT = 200;

interface IndexedMessage extends MessageDoc {
	indexDirty?: boolean;
	messageKey?: string;
	indexPreviousThreadIds?: string[];
	indexSchemaVersion?: number;
}
interface ThreadIndex {
	schemaVersion: number;
	threadId: string;
	latestId: string;
	previousId: string | null;
	status: MessageDoc["status"];
	pinned: boolean;
	sortAt: string;
	snoozeUntil: string | null;
	messageCount: number;
	unreadCount: number;
	participants: { from: string; direction: MessageDoc["direction"] }[];
	listKey: string;
	snoozeKey: string;
}
interface SearchDocument { messageKey: string; subject: string; body: string }
interface MigrationState { version: number; cursor?: string; complete: boolean }
interface Page<T> { items: T[]; cursor?: string; hasMore: boolean; indexing?: boolean }
export interface ThreadPageInput { status?: StatusFilter; limit?: number; cursor?: string }
export interface SearchPageInput { query: string; limit?: number; cursor?: string }
export type MessagePatch = (message: MessageDoc) => Partial<MessageDoc> | null;
export class MailboxInputError extends Error {
	constructor(message: string) { super(message); this.name = "MailboxInputError"; }
}

/** Public messages omit private attachment keys and internal projection metadata. */
export function mailboxPublicMessage(message: MessageDoc) {
	const { bodyRaw: _raw, indexDirty: _dirty, indexPreviousThreadIds: _old, indexSchemaVersion: _schema, messageKey: _key, ...publicFields } = message as IndexedMessage;
	return publicMessage(publicFields);
}

function messageThread(message: MessageDoc): string { return message.threadId ?? message.messageId; }
function iso(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error("Message has an invalid timestamp");
	return date.toISOString();
}
function makeMessageKey(id: string, message: MessageDoc): string {
	return `${iso(message.receivedAt)}|${encodeURIComponent(id)}`;
}
export function prepareMessage(id: string, message: IndexedMessage, previous?: IndexedMessage): IndexedMessage {
	const oldThreads = new Set(previous?.indexPreviousThreadIds ?? message.indexPreviousThreadIds ?? []);
	if (previous && messageThread(previous) !== messageThread(message)) oldThreads.add(messageThread(previous));
	return {
		...message, threadId: messageThread(message),
		sortAt: message.sortAt ?? message.receivedAt,
		snoozeUntil: message.snoozeUntil ?? null,
		read: typeof message.read === "boolean" ? message.read : true,
		pinned: message.pinned ?? false,
		status: message.status ?? (message.direction === "outbound" ? "done" : "inbox"),
		messageKey: previous?.messageKey ?? message.messageKey ?? makeMessageKey(id, message),
		indexSchemaVersion: INDEX_VERSION, indexDirty: true,
		indexPreviousThreadIds: [...oldThreads],
	};
}

/** Real messages are never deleted; the dirty marker commits with their data. */
export async function putMessage(ctx: any, id: string, message: MessageDoc): Promise<void> {
	if ((message.status === "draft" || message.status === "outbox")) throw new Error("Drafts must use draft storage operations");
	const result = await ctx.storage.messages.compareAndSet(id, null, prepareMessage(id, message));
	if (!result.applied) throw new Error("Message already exists");
}

/** Merge against a fresh SQL revision so unrelated concurrent changes survive. */
export async function mutateMessage(ctx: any, id: string, patch: MessagePatch): Promise<MessageDoc | null> {
	for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
		const snapshot = await ctx.storage.messages.getVersioned(id);
		if (!snapshot || (snapshot.value.status === "draft" || snapshot.value.status === "outbox")) return null;
		const changes = patch(snapshot.value);
		if (changes === null) return null;
		const next = prepareMessage(id, { ...snapshot.value, ...changes }, snapshot.value);
		if ((next.status === "draft" || next.status === "outbox")) throw new Error("Thread operations cannot turn a message into a draft");
		const result = await ctx.storage.messages.compareAndSet(id, snapshot.revision, next);
		if (result.applied) return next;
	}
	throw new Error("Message changed repeatedly; retry the operation");
}

export async function mutateThread(ctx: any, threadId: string, patch: MessagePatch): Promise<{ updated: number }> {
	const rows = await loadThreadRows(ctx, threadId);
	let updated = 0;
	for (const row of rows) {
		if (await mutateMessage(ctx, row.id, (message) => messageThread(message) === threadId ? patch(message) : null)) updated++;
	}
	return { updated };
}

function header(raw: string | null, name: string): string | null {
	if (!raw) return null;
	const headers = raw.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[\t ]+/g, " ");
	const prefix = `${name.toLowerCase()}:`;
	const found = headers.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(prefix));
	return found?.slice(prefix.length).trim() || null;
}

/** Resolve old unthreaded/orphan rows without assuming ancestors share a page. */
async function legacyThread(ctx: any, message: MessageDoc, seen = new Set<string>()): Promise<{ threadId: string; inReplyTo: string | null }> {
	const inReplyTo = message.inReplyTo ?? header(message.bodyRaw, "In-Reply-To");
	if (message.threadId && message.threadId !== message.messageId) return { threadId: message.threadId, inReplyTo };
	if (seen.has(message.messageId)) return { threadId: message.messageId, inReplyTo };
	if (seen.size >= 100) throw new Error("Historical message ancestry exceeds the migration safety limit");
	seen.add(message.messageId);
	const references = message.references ?? header(message.bodyRaw, "References")?.split(/\s+/).filter(Boolean) ?? [];
	const candidates = [...new Set([...(inReplyTo ? [inReplyTo] : []), ...[...references].reverse()])];
	const parents = new Map<string, { messageId: string; threadId: string | null }>();
	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		const result = await ctx.storage.messages.query({ where: { messageId: candidate }, limit: 1 });
		const parent = result.items?.[0]?.data as MessageDoc | undefined;
		if (!parent || (parent.status === "draft" || parent.status === "outbox")) continue;
		const resolved = await legacyThread(ctx, parent, new Set(seen));
		parents.set(candidate, { messageId: parent.messageId, threadId: resolved.threadId });
		break;
	}
	return deriveThreadInfo(message.messageId, inReplyTo, references, (id) => parents.get(id) ?? null);
}

async function migratePage(ctx: any): Promise<boolean> {
	const snapshot = await ctx.kv.getVersioned(MAILBOX_MIGRATION_KEY);
	const state = snapshot?.value as MigrationState | undefined;
	if (state?.version === INDEX_VERSION && state.complete) return true;
	const page = await ctx.storage.messages.query({ limit: MIGRATION_PAGE_SIZE, cursor: state?.version === INDEX_VERSION ? state.cursor : undefined });
	for (const row of page.items as MessageRow<IndexedMessage>[]) {
		for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
			const current = await ctx.storage.messages.getVersioned(row.id);
			if (!current || (current.value.status === "draft" || current.value.status === "outbox") || current.value.indexSchemaVersion === INDEX_VERSION) break;
			const derived = await legacyThread(ctx, current.value);
			const next = prepareMessage(row.id, { ...current.value, ...derived }, current.value);
			const written = await ctx.storage.messages.compareAndSet(row.id, current.revision, next);
			if (written.applied) break;
			if (attempt === MAX_CAS_ATTEMPTS - 1) throw new Error("Historical message changed repeatedly; retry indexing");
		}
	}
	if (page.hasMore && (!page.cursor || page.cursor === state?.cursor)) throw new Error("Migration cursor did not advance");
	const complete = !page.hasMore;
	if (complete) {
		await ctx.kv.delete("settings:accountId");
		await ctx.kv.delete("settings:apiToken");
	}
	const next: MigrationState = { version: INDEX_VERSION, complete, ...(page.cursor ? { cursor: page.cursor } : {}) };
	const committed = await ctx.kv.compareAndSet(MAILBOX_MIGRATION_KEY, snapshot?.revision ?? null, next);
	return committed.applied && complete;
}

/** Keep only summary fields between source pages, never whole message bodies. */
async function makeThreadIndex(ctx: any, threadId: string): Promise<ThreadIndex | null> {
	type Head = MessageRow<Pick<MessageDoc, "receivedAt" | "status" | "sortAt" | "snoozeUntil">>;
	type Participant = MessageRow<Pick<MessageDoc, "receivedAt" | "from" | "direction">>;
	let latest: Head | null = null;
	let previous: Head | null = null;
	let pinned = false;
	let messageCount = 0;
	let unreadCount = 0;
	let cursor: string | undefined;
	const participantsByAddress = new Map<string, Participant>();
	do {
		const page = await ctx.storage.messages.query({ where: { threadId }, limit: 50, cursor });
		for (const { id, data } of page.items as MessageRow[]) {
			if ((data.status === "draft" || data.status === "outbox")) continue;
			messageCount++;
			if (data.read === false) unreadCount++;
			pinned ||= data.pinned;
			const head: Head = { id, data: { receivedAt: data.receivedAt, status: data.status, sortAt: data.sortAt, snoozeUntil: data.snoozeUntil } };
			if (!latest || chronological(latest, head) < 0) { previous = latest; latest = head; }
			else if (!previous || chronological(previous, head) < 0) previous = head;
			const key = `${data.direction}|${data.from.toLowerCase()}`;
			const participant: Participant = { id, data: { receivedAt: data.receivedAt, from: data.from, direction: data.direction } };
			const existing = participantsByAddress.get(key);
			if (!existing || chronological(participant, existing) < 0) participantsByAddress.set(key, participant);
		}
		if (!page.hasMore) break;
		if (!page.cursor || page.cursor === cursor) throw new Error("Projection cursor did not advance");
		cursor = page.cursor;
	} while (cursor);
	if (!latest) return null;
	const sortAt = latest.data.sortAt ?? latest.data.receivedAt;
	const snoozeUntil = latest.data.snoozeUntil ?? null;
	const tail = encodeURIComponent(threadId);
	const rank = pinned ? "0" : "1";
	// Date's full supported epoch range, shifted/inverted into a fixed width.
	const descendingTime = (8640000000000000n - BigInt(new Date(iso(sortAt)).getTime())).toString().padStart(17, "0");
	const participants = [...participantsByAddress.values()].sort(chronological).map(({ data }) => ({ direction: data.direction, from: data.from }));
	return {
		schemaVersion: INDEX_VERSION, threadId, latestId: latest.id,
		previousId: previous?.id ?? null,
		status: latest.data.status, pinned, sortAt, snoozeUntil,
		messageCount, unreadCount,
		participants, listKey: `${rank}|${descendingTime}|${tail}`,
		snoozeKey: `${rank}|${snoozeUntil ? iso(snoozeUntil) : ""}|${tail}`,
	};
}

async function refreshThread(ctx: any, threadId: string): Promise<void> {
	for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
		// Capture before the source scan: an older scan cannot replace a newer publication.
		const snapshot = await ctx.storage.threads.getVersioned(threadId);
		const projection = await makeThreadIndex(ctx, threadId);
		if (!projection) {
			if (!snapshot || (await ctx.storage.threads.compareAndDelete(threadId, snapshot.revision)).applied) return;
		} else if ((await ctx.storage.threads.compareAndSet(threadId, snapshot?.revision ?? null, projection)).applied) return;
	}
	throw new Error("Conversation changed repeatedly; retry indexing");
}

async function repairDirtyMessages(ctx: any): Promise<boolean> {
	const page = await ctx.storage.messages.query({ where: { indexDirty: true }, limit: REPAIR_MESSAGE_LIMIT });
	const captured: { id: string; revision: string; value: IndexedMessage; searchRevision: string | null }[] = [];
	const threadIds = new Set<string>();
	for (const row of page.items as MessageRow[]) {
		// Capture search revision before the source snapshot for the same reason as threads.
		const search = await ctx.storage.searchDocuments.getVersioned(row.id);
		const source = await ctx.storage.messages.getVersioned(row.id);
		if (!source || (source.value.status === "draft" || source.value.status === "outbox") || !source.value.indexDirty) continue;
		captured.push({ id: row.id, ...source, searchRevision: search?.revision ?? null });
		threadIds.add(messageThread(source.value));
		for (const previous of source.value.indexPreviousThreadIds ?? []) threadIds.add(previous);
	}
	for (const threadId of threadIds) await refreshThread(ctx, threadId);
	for (const source of captured) {
		const doc: SearchDocument = { messageKey: source.value.messageKey!, subject: (source.value.subject ?? "").toLowerCase(), body: (source.value.bodyText ?? "").toLowerCase() };
		const published = await ctx.storage.searchDocuments.compareAndSet(source.id, source.searchRevision, doc);
		if (!published.applied) continue;
		await ctx.storage.messages.compareAndSet(source.id, source.revision, { ...source.value, indexDirty: false, indexPreviousThreadIds: [] });
	}
	return !(await ctx.storage.messages.query({ where: { indexDirty: true }, limit: 1 })).items.length;
}

/** Bounded resumable backfill/repair. Never treat an incomplete index as an empty mailbox. */
export async function ensureMailboxIndex(ctx: any): Promise<{ complete: boolean }> {
	const migrated = await migratePage(ctx);
	const repaired = await repairDirtyMessages(ctx);
	return { complete: migrated && repaired };
}

/** Direct operations need historical thread IDs, but read authoritative messages, not projections. */
export async function requireMailboxReady(ctx: any): Promise<void> {
	if (!(await migratePage(ctx))) {
		throw new MailboxInputError("Mailbox indexing is still in progress; retry this operation.");
	}
}

interface Cursor { v: number; kind: "threads" | "search"; filter: string; after: string }
function encodeCursor(cursor: Cursor): string {
	const bytes = new TextEncoder().encode(JSON.stringify(cursor));
	return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(value: string | undefined, kind: Cursor["kind"], filter: string): string | undefined {
	if (value === undefined) return undefined;
	try {
		if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
		const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
		const cursor = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as Cursor;
		if (cursor.v !== INDEX_VERSION || cursor.kind !== kind || cursor.filter !== filter || typeof cursor.after !== "string" || !cursor.after) throw new Error();
		return cursor.after;
	} catch { throw new MailboxInputError("Invalid pagination cursor for this request"); }
}
function pageLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1 || value > 100) throw new MailboxInputError("limit must be an integer from 1 to 100");
	return value;
}
function indexingPage<T>(): Page<T> { return { items: [], hasMore: true, indexing: true }; }

export async function listThreadPage(ctx: any, input: ThreadPageInput = {}) {
	const status = input.status ?? "inbox";
	if (!["inbox", "snoozed", "done", "all"].includes(status)) throw new MailboxInputError("Invalid mailbox status");
	const limit = pageLimit(input.limit, 25);
	const after = decodeCursor(input.cursor, "threads", status);
	if (!(await ensureMailboxIndex(ctx)).complete) return indexingPage<any>();
	const field = status === "snoozed" ? "snoozeKey" : "listKey";
	const result = await ctx.storage.threads.query({
		where: { ...(status === "all" ? {} : { status }), ...(after ? { [field]: { gt: after } } : {}) },
		orderBy: { [field]: "asc" }, limit,
	});
	const rows = result.items as MessageRow<ThreadIndex>[];
	const ids = [...new Set(rows.flatMap(({ data }) => [data.latestId, ...(data.previousId ? [data.previousId] : [])]))];
	const messages = new Map<string, MessageDoc>();
	for (let i = 0; i < ids.length; i += 100) {
		for (const [id, message] of await ctx.storage.messages.getMany(ids.slice(i, i + 100))) messages.set(id, message);
	}
	const senderAddress = (await ctx.kv.get("settings:senderAddress")) ?? "";
	const items = rows.map(({ data }) => {
		const latest = messages.get(data.latestId);
		if (!latest) throw new Error("Indexed message is missing; rebuild the mailbox index");
		const previous = data.previousId ? messages.get(data.previousId) : null;
		return {
			id: data.threadId, threadId: data.threadId, openMessageId: data.latestId,
			latest: mailboxPublicMessage(latest), previous: previous ? mailboxPublicMessage(previous) : null,
			messageCount: data.messageCount, unreadCount: data.unreadCount,
			participants: deriveParticipantChips(data.participants as MessageDoc[], senderAddress),
			pinned: data.pinned, sortAt: data.sortAt, snoozeUntil: data.snoozeUntil,
		};
	});
	const cursor = result.hasMore && rows.length ? encodeCursor({ v: INDEX_VERSION, kind: "threads", filter: status, after: rows.at(-1)!.data[field] }) : undefined;
	return { items, cursor, hasMore: !!result.hasMore };
}

export async function searchMessagePage(ctx: any, input: SearchPageInput): Promise<Page<ReturnType<typeof mailboxPublicMessage> & { id: string }>> {
	if (typeof input.query !== "string" || !input.query.length || input.query.length > 1000) throw new MailboxInputError("query must contain 1 to 1000 characters");
	const query = input.query.toLowerCase();
	const limit = pageLimit(input.limit, 20);
	let after = decodeCursor(input.cursor, "search", query);
	if (!(await ensureMailboxIndex(ctx)).complete) return indexingPage();
	const matchedIds: string[] = [];
	let inspected = 0;
	let hasMore = false;
	do {
		const page = await ctx.storage.searchDocuments.query({ where: after ? { messageKey: { lt: after } } : {}, orderBy: { messageKey: "desc" }, limit: Math.min(100, SEARCH_SCAN_LIMIT - inspected) });
		const rows = page.items as MessageRow<SearchDocument>[];
		hasMore = !!page.hasMore;
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i]; after = row.data.messageKey; inspected++;
			if (row.data.subject.includes(query) || row.data.body.includes(query)) matchedIds.push(row.id);
			if (matchedIds.length === limit) { hasMore = i < rows.length - 1 || !!page.hasMore; break; }
		}
		if (matchedIds.length === limit || inspected >= SEARCH_SCAN_LIMIT || !page.hasMore) break;
	} while (after);
	const messages = await ctx.storage.messages.getMany(matchedIds) as Map<string, MessageDoc>;
	const items = matchedIds.flatMap((id) => { const message = messages.get(id); return message && message.status !== "draft" && message.status !== "outbox" ? [{ ...mailboxPublicMessage(message), id }] : []; });
	return { items, hasMore, cursor: hasMore && after ? encodeCursor({ v: INDEX_VERSION, kind: "search", filter: query, after }) : undefined };
}

export async function wakeSnoozed(ctx: any, now: string): Promise<number> {
	const rows = await allRows<MessageDoc>(ctx.storage.messages, { where: { status: "snoozed", snoozeUntil: { lte: now } } });
	let woken = 0;
	for (const row of rows) {
		if (await mutateMessage(ctx, row.id, (message) => message.status === "snoozed" && message.snoozeUntil && message.snoozeUntil <= now ? { status: "inbox", sortAt: now, snoozeUntil: null } : null)) woken++;
	}
	return woken;
}
