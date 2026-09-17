import { beginThreadMutation, endThreadMutation } from "./threadMutation";
import { PluginRouteError } from "emdash";
import type { MessageDoc } from "../index";
import { BUNDLE_IDS, canonicalSender, builtinAssignment, NO_BUNDLE, isBundleId, validEnabledBundles, type BundleId, type BundleAssignment, type BundleEvidence, type BundleOverride, type BundleRule } from "./bundles";
import { allRows, ensureMailboxIndex, requireMailboxReady, makeThreadIndex, refreshThread, threadSummaries, encodeCursor, decodeCursor, pageLimit, MailboxInputError, type MessageRow, type ThreadIndex } from "./mailboxStore";
export const bundleCollections = {
    bundleOverrides: { indexes: ["dirty"] },
    bundleRules: { indexes: ["sender"], uniqueIndexes: ["sender"] },
};
export interface BundleSummary {
    id: BundleId;
    count: number;
    unreadCount: number;
    senders: string[];
}
export interface BundleOverview {
    bundles: BundleSummary[];
    totalCount: number;
    unreadCount: number;
    indexing?: boolean;
}
export interface BundlePageInput {
    section: "conversations" | BundleId;
    enabled?: BundleId[];
    limit?: number;
    cursor?: string;
}
export interface BundleMoveInput {
    threadId: string;
    bundle: BundleId | null;
    saveSenderRule?: boolean;
    replaceRule?: boolean;
    expectedSender?: string;
}
export interface BundleMoveResult {
    assignment: BundleAssignment;
    moved: true;
    ruleSaved?: boolean;
    ruleError?: string;
}
/** Called only for new real messages. Failure remains visible and can never block inbound mail. */
export async function captureBundleEvidence(ctx: any, message: MessageDoc): Promise<BundleEvidence> {
    if (message.direction !== "inbound")
        return { version: 1, assignment: { ...NO_BUNDLE } };
    try {
        const sender = canonicalSender(message.from);
        const rule = sender ? await ctx.storage.bundleRules.get(sender) as BundleRule | null : null;
        return { version: 1, assignment: rule ? { bundle: rule.bundle, source: "sender", ruleId: rule.id, sender: rule.sender } : builtinAssignment(message) };
    }
    catch {
        ctx.log?.warn?.("Bundle evidence unavailable; message remains ordinary");
        return { version: 1, failed: true, assignment: { ...NO_BUNDLE } };
    }
}
function objectInput(value: unknown, keys: string[]): Record<string, any> {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
        throw PluginRouteError.badRequest("Invalid bundle request fields");
    return value as Record<string, any>;
}
function destination(value: unknown): asserts value is BundleId | null {
    if (value !== null && !isBundleId(value))
        throw PluginRouteError.badRequest("Choose a known bundle or no bundle");
}
export function bundlePresentationKeys(section: BundlePageInput["section"], enabled: BundleId[]): string[] {
    return section === "conversations" ? ["conversations", ...BUNDLE_IDS.filter(id => !enabled.includes(id))] : [section];
}
export async function bundleOverview(ctx: any): Promise<BundleOverview> {
    if (!(await ensureMailboxIndex(ctx)).complete)
        return { bundles: [], totalCount: 0, unreadCount: 0, indexing: true };
    const bundles: BundleSummary[] = [];
    for (const id of BUNDLE_IDS) {
        const where = { bundlePresentation: id };
        const [count, unreadCount, preview] = await Promise.all([ctx.storage.threads.count(where), ctx.storage.threads.count({ ...where, hasUnread: true }), ctx.storage.threads.query({ where, orderBy: { listKey: "asc" }, limit: 3 })]);
        bundles.push({ id, count, unreadCount, senders: [...new Set<string>(preview.items.map((r: MessageRow<ThreadIndex>) => r.data.latestIncomingSender).filter(Boolean))] });
    }
    const [totalCount, unreadCount] = await Promise.all([ctx.storage.threads.count({ status: "inbox" }), ctx.storage.threads.count({ status: "inbox", hasUnread: true })]);
    return { bundles, totalCount, unreadCount };
}
/** Uses an indexed IN predicate with one global sort; disabled bundles and pins cannot disappear between subset pages. */
export async function listBundlePage(ctx: any, input: BundlePageInput) {
    objectInput(input, ["section", "enabled", "limit", "cursor"]);
    if (input.section !== "conversations" && !isBundleId(input.section))
        throw PluginRouteError.badRequest("Choose a valid bundle section");
    const enabled = input.enabled === undefined ? [...BUNDLE_IDS] : input.enabled;
    if (!validEnabledBundles(enabled))
        throw PluginRouteError.badRequest("enabled must contain unique known bundles");
    const limit = pageLimit(input.limit, 25);
    const filter = JSON.stringify([input.section, BUNDLE_IDS.filter(id => enabled.includes(id))]);
    const after = decodeCursor(input.cursor, "bundles", filter);
    if (!(await ensureMailboxIndex(ctx)).complete)
        return { items: [], hasMore: true, indexing: true };
    const page = await ctx.storage.threads.query({ where: { bundlePresentation: { in: bundlePresentationKeys(input.section, enabled) }, ...(after ? { listKey: { gt: after } } : {}) }, orderBy: { listKey: "asc" }, limit });
    const rows = page.items as MessageRow<ThreadIndex>[];
    return { items: await threadSummaries(ctx, rows), hasMore: page.hasMore, cursor: page.hasMore && rows.length ? encodeCursor({ v: 2, kind: "bundles", filter, after: rows.at(-1)!.data.listKey }) : undefined };
}
/** Fresh source fold for operations; callers must revalidate these revisions at mutation time. */
export async function readBundleThreadSnapshot(ctx: any, threadId: string) {
    await requireMailboxReady(ctx);
    const override = await ctx.storage.bundleOverrides.getVersioned(threadId);
    const projection = await makeThreadIndex(ctx, threadId);
    if (!projection)
        return null;
    const [latest, incoming] = await Promise.all([ctx.storage.messages.getVersioned(projection.latestId), projection.latestIncomingId ? ctx.storage.messages.getVersioned(projection.latestIncomingId) : null]);
    return { projection, latest, incoming, override };
}
export function isEligibleBundleThread(thread: ThreadIndex, bundle: BundleId): boolean {
    return thread.status === "inbox" && !thread.pinned && thread.bundle.bundle === bundle;
}
export async function listBundleRules(ctx: any) {
    return { rules: (await allRows<BundleRule>(ctx.storage.bundleRules)).map(row => row.data).sort((a, b) => a.sender.localeCompare(b.sender)), explanation: "Conversation override, then the exact sender rule saved when incoming mail arrived, then built-in matching. Outgoing replies do not change grouping. Sender rules apply to future mail; uncertain mail stays in Conversations." };
}
export async function moveBundleThread(ctx: any, input: BundleMoveInput): Promise<BundleMoveResult> {
    objectInput(input, ["threadId", "bundle", "saveSenderRule", "replaceRule", "expectedSender"]);
    if (typeof input.threadId !== "string" || !input.threadId || input.threadId.length > 1000)
        throw PluginRouteError.badRequest("threadId is required");
    destination(input.bundle);
    for (const key of ["saveSenderRule", "replaceRule"] as const)
        if (input[key] !== undefined && typeof input[key] !== "boolean")
            throw PluginRouteError.badRequest(`${key} must be boolean`);
    if (input.replaceRule && !input.saveSenderRule)
        throw PluginRouteError.badRequest("Replacement requires saving a sender rule");
    if (input.expectedSender !== undefined && (!input.saveSenderRule || typeof input.expectedSender !== "string" || canonicalSender(input.expectedSender) !== input.expectedSender))
        throw PluginRouteError.badRequest("expectedSender must be a canonical sender for a saved rule");
    const snapshot = await readBundleThreadSnapshot(ctx, input.threadId);
    if (!snapshot)
        throw PluginRouteError.notFound("Conversation not found");
    // Derive this from actual newest incoming mail, not caller input or the latest outgoing reply.
    const sender = snapshot.incoming ? canonicalSender(snapshot.incoming.value.from) : null;
    if (input.expectedSender !== undefined && input.expectedSender !== sender)
        throw PluginRouteError.conflict("The latest incoming sender changed; review the sender before saving a rule");
    let ruleSnapshot: any = null;
    if (input.saveSenderRule) {
        if (!sender)
            throw PluginRouteError.badRequest("This conversation has no single valid incoming sender");
        ruleSnapshot = await ctx.storage.bundleRules.getVersioned(sender);
        if (ruleSnapshot && ruleSnapshot.value.bundle !== input.bundle && !input.replaceRule)
            throw PluginRouteError.conflict("A rule already exists for this sender; explicitly replace it to continue");
    }
    const assignment: BundleAssignment = { bundle: input.bundle, source: "manual" };
    const override: BundleOverride = { version: 1, threadId: input.threadId, bundle: input.bundle, dirty: true };
    const guard = await beginThreadMutation(ctx, [input.threadId]);
    const moved = await ctx.storage.bundleOverrides.compareAndSet(input.threadId, snapshot.override?.revision ?? null, override);
    if (!moved.applied) {
        await endThreadMutation(ctx, guard);
        throw PluginRouteError.conflict("Conversation assignment changed; reload and retry");
    }
    await endThreadMutation(ctx, guard);
    // The dirty override is durable before publication. A repair failure must not turn a committed move into a false failure.
    try {
        await refreshThread(ctx, input.threadId);
    }
    catch {
        ctx.log?.warn?.("Bundle move saved; projection repair pending");
    }
    const result: BundleMoveResult = { assignment, moved: true };
    if (input.saveSenderRule && sender) {
        try {
            const rule: BundleRule = { version: 1, id: sender, sender, bundle: input.bundle };
            const saved = await ctx.storage.bundleRules.compareAndSet(sender, ruleSnapshot?.revision ?? null, rule);
            if (!saved.applied)
                throw Error("Sender rule changed during this move; review it before retrying");
            result.ruleSaved = true;
        }
        catch {
            result.ruleSaved = false;
            result.ruleError = "Conversation moved, but the future sender rule could not be saved. Review the current rule and retry.";
        }
    }
    return result;
}
export const bundleRoutes = {
    "bundles/overview": { permission: "plugins:manage" as const, handler: async (ctx: any) => { objectInput(ctx.input ?? {}, []); return bundleOverview(ctx); } },
    "bundles/list": { permission: "plugins:manage" as const, handler: async (ctx: any) => { try {
            return await listBundlePage(ctx, ctx.input);
        }
        catch (error) {
            if (error instanceof MailboxInputError)
                throw PluginRouteError.badRequest(error.message);
            throw error;
        } } },
    "bundles/move": { permission: "plugins:manage" as const, handler: async (ctx: any) => { try {
            return await moveBundleThread(ctx, ctx.input);
        }
        catch (error) {
            if (error instanceof MailboxInputError)
                throw PluginRouteError.badRequest(error.message);
            throw error;
        } } },
    "bundles/rules": { permission: "plugins:manage" as const, handler: async (ctx: any) => { objectInput(ctx.input ?? {}, []); return listBundleRules(ctx); } },
};
