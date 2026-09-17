import { PluginRouteError } from "emdash";
import { isBundleId, type BundleId } from "./bundles";
import { isEligibleBundleThread } from "./bundleStore";
import { ensureMailboxIndex, makeThreadIndex, prepareMessage, refreshThread, threadSummaries, pageLimit, MailboxInputError } from "./mailboxStore";
import { hasThreadMutation, finishMessageAdmission } from "./threadMutation";
const BATCH = 25;
const ADMISSION_MIGRATION = "state:bundle-admission:v1";
export const bundleOperationCollections = {
    bundleOperations: { indexes: ["userId"] },
    bundleCandidates: { indexes: ["operationId", ["operationId", "outcome"], ["operationId", "unread"]] },
};
type Phase = "preparing" | "ready" | "running" | "complete";
type Outcome = "pending" | "done" | "skipped" | "failed";
interface Operation {
    version: 1;
    id: string;
    userId: string;
    requestId: string;
    bundle: BundleId;
    phase: Phase;
    cutoff: string | null;
    cursor?: string;
    reconcileCursor?: string;
    retrying?: boolean;
    retryCursor?: string;
}
interface Candidate {
    version: 1;
    operationId: string;
    threadId: string;
    latestId: string;
    latestRevision: string;
    incomingId: string | null;
    overrideRevision: string | null;
    assignment: string;
    unread: boolean;
    outcome: Outcome;
    reason?: string;
}
function userId(ctx: any): string {
    if (!ctx.user?.id)
        throw PluginRouteError.unauthorized("Sign in to complete a bundle");
    return ctx.user.id;
}
function input(value: any, keys: string[]) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
        throw PluginRouteError.badRequest("Invalid bundle operation fields");
    return value;
}
function identifier(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string" || !value.length || value.length > 300)
        throw PluginRouteError.badRequest(`${name} must be a nonempty string of at most 300 characters`);
}
async function key(...values: string[]) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function owned(ctx: any, id: unknown) {
    const owner = userId(ctx);
    identifier(id, "operationId");
    const record = await ctx.storage.bundleOperations.getVersioned(id);
    if (!record || record.value.userId !== owner)
        throw PluginRouteError.notFound("Bundle operation not found");
    return record as {
        value: Operation;
        revision: string;
    };
}
async function updateOperation(ctx: any, snapshot: {
    value: Operation;
    revision: string;
}, patch: Partial<Operation>) {
    await ctx.storage.bundleOperations.compareAndSet(snapshot.value.id, snapshot.revision, { ...snapshot.value, ...patch });
    return owned(ctx, snapshot.value.id);
}
/** Legacy source order is immutable; live unstamped publications are never mistaken for legacy rows. */
async function admissionReady(ctx: any): Promise<boolean> {
    if (!(await ensureMailboxIndex(ctx)).complete)
        return false;
    const saved = await ctx.kv.getVersioned(ADMISSION_MIGRATION);
    if (saved?.value.complete)
        return true;
    const page = await ctx.storage.messages.query({ limit: BATCH, cursor: saved?.value.cursor });
    for (const row of page.items) {
        const current = await ctx.storage.messages.get(row.id);
        if (current && !current.publicationPending && !current.admittedAt)
            await finishMessageAdmission(ctx, row.id);
    }
    if (page.hasMore && !page.cursor)
        throw Error("Admission migration cursor missing");
    const written = await ctx.kv.compareAndSet(ADMISSION_MIGRATION, saved?.revision ?? null, { complete: !page.hasMore, ...(page.hasMore ? { cursor: page.cursor } : {}) });
    return written.applied && !page.hasMore;
}
/** Capture H BEFORE folding eligibility. Every applicable writer fences H before changing source. */
async function snapshotThread(ctx: any, threadId: string) {
    const discovery = await makeThreadIndex(ctx, threadId);
    if (!discovery)
        return null;
    const latest = await ctx.storage.messages.getVersioned(discovery.latestId);
    if (!latest)
        return null;
    const projection = await makeThreadIndex(ctx, threadId);
    const override = await ctx.storage.bundleOverrides.getVersioned(threadId);
    const active = await hasThreadMutation(ctx, threadId);
    if (!projection || projection.latestId !== discovery.latestId)
        return null;
    return { latest, projection, override, active };
}
async function publishOutcome(ctx: any, id: string, outcome: Outcome, reason?: string) {
    for (let attempt = 0; attempt < 8; attempt++) {
        const current = await ctx.storage.bundleCandidates.getVersioned(id);
        if (!current)
            throw Error("Bundle candidate missing");
        if (current.value.outcome === "done" || (outcome !== "done" && current.value.outcome === "skipped"))
            return;
        if ((await ctx.storage.bundleCandidates.compareAndSet(id, current.revision, { ...current.value, outcome, reason })).applied)
            return;
    }
    throw Error("Bundle outcome changed repeatedly");
}
/** A previous receipt must become terminal in its own journal BEFORE its source slot is replaced. */
async function settleReceipt(ctx: any, receipt: {
    operationId: string;
    candidateId: string;
}, sourceId: string) {
    const candidate = await ctx.storage.bundleCandidates.get(receipt.candidateId) as Candidate | null;
    if (!candidate || candidate.operationId !== receipt.operationId || candidate.latestId !== sourceId)
        throw Error("Invalid durable bundle receipt");
    await publishOutcome(ctx, receipt.candidateId, "done");
    if ((await ctx.storage.bundleCandidates.get(receipt.candidateId))?.outcome !== "done")
        throw Error("Prior bundle receipt is unresolved");
}
async function reconcileCandidate(ctx: any, id: string, candidate: Candidate): Promise<boolean> {
    if (candidate.outcome === "done")
        return true;
    const source = await ctx.storage.messages.get(candidate.latestId);
    if (source?.bulkReceipt?.candidateId === id && source.bulkReceipt.operationId === candidate.operationId) {
        await settleReceipt(ctx, source.bulkReceipt, candidate.latestId);
        return true;
    }
    return false;
}
async function view(ctx: any, operation: Operation) {
    const counts = { pending: 0, done: 0, skipped: 0, failed: 0 };
    for (const outcome of Object.keys(counts) as Outcome[])
        counts[outcome] = await ctx.storage.bundleCandidates.count({ operationId: operation.id, outcome });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const unreadCount = await ctx.storage.bundleCandidates.count({ operationId: operation.id, unread: true });
    const workRemaining = operation.phase === "preparing" || operation.phase === "running";
    return { id: operation.id, phase: operation.phase, bundle: operation.bundle, total, unreadCount, counts, outcomes: counts, hasMore: workRemaining, workRemaining, retryable: counts.failed > 0 };
}
export async function prepareBundleDone(ctx: any, args: any) {
    input(args, ["bundle", "requestId"]);
    const owner = userId(ctx);
    if (!isBundleId(args.bundle))
        throw PluginRouteError.badRequest("Choose a known bundle");
    identifier(args.requestId, "requestId");
    const id = await key(owner, args.requestId);
    let saved = await ctx.storage.bundleOperations.getVersioned(id);
    if (!saved) {
        const operation: Operation = { version: 1, id, userId: owner, requestId: args.requestId, bundle: args.bundle, phase: "preparing", cutoff: null };
        // Unknown acknowledgement is recovered by the same user/request key, never a new operation.
        try {
            await ctx.storage.bundleOperations.compareAndSet(id, null, operation);
        }
        catch (error) {
            if (!await ctx.storage.bundleOperations.get(id))
                throw error;
        }
        saved = await owned(ctx, id);
    }
    if (saved.value.bundle !== args.bundle)
        throw PluginRouteError.conflict("This request already belongs to another bundle");
    if (saved.value.phase !== "preparing")
        return view(ctx, saved.value);
    if (!saved.value.cutoff) {
        if (!await admissionReady(ctx))
            return view(ctx, saved.value);
        saved = await updateOperation(ctx, saved, { cutoff: new Date().toISOString() });
    }
    if (saved.value.phase !== "preparing")
        return view(ctx, saved.value);
    const op = saved.value as Operation;
    // Fixed indexed admission predicate bounds the tail; host created-at/id order never changes.
    const page = await ctx.storage.messages.query({ where: { admittedAt: { lt: op.cutoff } }, limit: BATCH, cursor: op.cursor });
    for (const row of page.items) {
        if (row.data.status === "draft" || row.data.status === "outbox")
            continue;
        const threadId = row.data.threadId ?? row.data.messageId;
        const candidateId = await key(id, threadId);
        if (await ctx.storage.bundleCandidates.get(candidateId))
            continue;
        const state = await snapshotThread(ctx, threadId);
        if (!state || !isEligibleBundleThread(state.projection, op.bundle))
            continue;
        const reason = state.active ? "mutation_unresolved" : !state.projection.admissionComplete ? "admission_unresolved" : !state.projection.maxAdmittedAt || state.projection.maxAdmittedAt >= op.cutoff! ? "new_mail" : undefined;
        const candidate: Candidate = { version: 1, operationId: id, threadId, latestId: state.projection.latestId, latestRevision: state.latest.revision, incomingId: state.projection.latestIncomingId, overrideRevision: state.override?.revision ?? null, assignment: JSON.stringify(state.projection.bundle), unread: state.projection.hasUnread, outcome: reason ? "skipped" : "pending", ...(reason ? { reason } : {}) };
        await ctx.storage.bundleCandidates.compareAndSet(candidateId, null, candidate);
    }
    if (page.hasMore && (!page.cursor || page.cursor === op.cursor))
        throw Error("Bundle snapshot cursor did not advance");
    saved = await updateOperation(ctx, saved, { cursor: page.hasMore ? page.cursor : undefined, phase: page.hasMore ? "preparing" : "ready" });
    return view(ctx, saved.value);
}
async function runCandidate(ctx: any, op: Operation, id: string, candidate: Candidate) {
    try {
        if (await reconcileCandidate(ctx, id, candidate))
            return;
        const state = await snapshotThread(ctx, candidate.threadId);
        const reason = !state ? "thread_changed" : state.active ? "mutation_unresolved" : !state.projection.admissionComplete ? "admission_unresolved" : state.projection.maxAdmittedAt! >= op.cutoff! ? "new_mail" : !isEligibleBundleThread(state.projection, op.bundle) ? "eligibility_changed" : state.projection.latestId !== candidate.latestId || state.latest.revision !== candidate.latestRevision || state.projection.latestIncomingId !== candidate.incomingId || (state.override?.revision ?? null) !== candidate.overrideRevision || JSON.stringify(state.projection.bundle) !== candidate.assignment ? "snapshot_changed" : undefined;
        if (reason || !state) {
            if (!await reconcileCandidate(ctx, id, candidate))
                await publishOutcome(ctx, id, "skipped", reason);
            return;
        }
        if (state.latest.value.bulkReceipt)
            await settleReceipt(ctx, state.latest.value.bulkReceipt, candidate.latestId);
        const next = { ...prepareMessage(candidate.latestId, { ...state.latest.value, status: "done", snoozeUntil: null }, state.latest.value), bulkReceipt: { operationId: op.id, candidateId: id } };
        const result = await ctx.storage.messages.compareAndSet(candidate.latestId, candidate.latestRevision, next);
        if (result.applied) {
            await publishOutcome(ctx, id, "done");
            await refreshThread(ctx, candidate.threadId);
        }
        else if (!await reconcileCandidate(ctx, id, candidate))
            await publishOutcome(ctx, id, "skipped", "snapshot_changed");
    }
    catch (error) {
        // Rejected SQL acknowledgement may have committed. Receipts always beat a stale failure.
        if (await reconcileCandidate(ctx, id, candidate))
            return;
        await publishOutcome(ctx, id, "failed", "storage_failure");
    }
}
export async function runBundleDone(ctx: any, args: any) {
    input(args, ["operationId", "retry"]);
    if (args.retry !== undefined && typeof args.retry !== "boolean")
        throw PluginRouteError.badRequest("retry must be boolean");
    let saved = await owned(ctx, args.operationId);
    if (saved.value.phase === "preparing")
        throw PluginRouteError.conflict("Prepare the complete snapshot before confirming");
    if (saved.value.phase === "ready")
        saved = await updateOperation(ctx, saved, { phase: "running" });
    else if (args.retry && saved.value.phase === "complete")
        saved = await updateOperation(ctx, saved, { phase: "running", retrying: true, retryCursor: undefined });
    if (saved.value.phase === "complete")
        return view(ctx, saved.value);
    const retrying = saved.value.retrying === true;
    const page = await ctx.storage.bundleCandidates.query({ where: { operationId: saved.value.id, outcome: retrying ? { in: ["pending", "failed"] } : "pending" }, limit: BATCH, ...(retrying ? { cursor: saved.value.retryCursor } : {}) });
    for (const row of page.items)
        await runCandidate(ctx, saved.value, row.id, row.data);
    if (retrying) {
        if (page.hasMore && !page.cursor)
            throw Error("Bundle retry cursor missing");
        await updateOperation(ctx, saved, { retryCursor: page.hasMore ? page.cursor : undefined, phase: page.hasMore ? "running" : "complete", retrying: page.hasMore });
    }
    else if (!await ctx.storage.bundleCandidates.count({ operationId: saved.value.id, outcome: "pending" }))
        await updateOperation(ctx, saved, { phase: "complete" });
    return view(ctx, (await owned(ctx, args.operationId)).value);
}
export async function bundleDoneStatus(ctx: any, args: any) {
    input(args, ["operationId"]);
    let saved = await owned(ctx, args.operationId);
    const page = await ctx.storage.bundleCandidates.query({ where: { operationId: saved.value.id }, limit: BATCH, cursor: saved.value.reconcileCursor });
    for (const row of page.items)
        await reconcileCandidate(ctx, row.id, row.data);
    saved = await updateOperation(ctx, saved, { reconcileCursor: page.hasMore ? page.cursor : undefined });
    if (saved.value.phase === "running" && !saved.value.retrying && !await ctx.storage.bundleCandidates.count({ operationId: saved.value.id, outcome: "pending" }))
        saved = await updateOperation(ctx, saved, { phase: "complete" });
    return view(ctx, saved.value);
}
export async function bundleDoneThreads(ctx: any, args: any) {
    input(args, ["operationId", "limit", "cursor"]);
    const saved = await owned(ctx, args.operationId);
    const limit = pageLimit(args.limit, 25);
    let after: string | undefined;
    if (args.cursor !== undefined) {
        try {
            const cursor = JSON.parse(atob(args.cursor));
            if (cursor.operationId !== saved.value.id || typeof cursor.after !== "string")
                throw Error();
            after = cursor.after;
        }
        catch {
            throw PluginRouteError.badRequest("Invalid operation cursor");
        }
    }
    const page = await ctx.storage.bundleCandidates.query({ where: { operationId: saved.value.id }, limit, cursor: after });
    const projections = [];
    for (const row of page.items) {
        await refreshThread(ctx, row.data.threadId);
    }
    const stored = await ctx.storage.threads.getMany(page.items.map((row: any) => row.data.threadId));
    for (const [id, data] of stored)
        projections.push({ id, data });
    const summaries = new Map((await threadSummaries(ctx, projections)).map(summary => [summary.threadId, summary]));
    return { items: page.items.map((row: any) => ({ threadId: row.data.threadId, openMessageId: row.data.latestId, outcome: row.data.outcome, reason: row.data.reason, summary: summaries.get(row.data.threadId) ?? null })), hasMore: page.hasMore, cursor: page.hasMore ? btoa(JSON.stringify({ operationId: saved.value.id, after: page.cursor })) : undefined };
}
function route(handler: (ctx: any, input: any) => Promise<any>) { return { permission: "plugins:manage" as const, handler: async (ctx: any) => { try {
        return await handler(ctx, ctx.input);
    }
    catch (error) {
        if (error instanceof MailboxInputError)
            throw PluginRouteError.badRequest(error.message);
        throw error;
    } } }; }
export const bundleOperationRoutes = { "bundles/done-prepare": route(prepareBundleDone), "bundles/done-run": route(runBundleDone), "bundles/done-status": route(bundleDoneStatus), "bundles/done-threads": route(bundleDoneThreads) };
