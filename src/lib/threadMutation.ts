import { makeThreadIndex } from "./mailboxStore";
export const threadMutationCollections = { threadMutationIntents: { indexes: ["threadId"] } };
export class MutationRejected extends Error {
}
export interface MutationIntent {
    id: string;
    threadId: string;
    createdAt: string;
}
export interface MutationGuard {
    intents: MutationIntent[];
    heads: Map<string, {
        id: string;
        receivedAt: string;
    }>;
}
/** Unique intents exclude bulk only. Never expire/steal them: a paused writer may resume. */
export async function beginThreadMutation(ctx: any, threadIds: string[]): Promise<MutationGuard> {
    const guard: MutationGuard = { intents: [], heads: new Map() };
    try {
        for (const threadId of [...new Set(threadIds)]) {
            const intent: MutationIntent = { id: crypto.randomUUID(), threadId, createdAt: new Date().toISOString() };
            try {
                const result = await ctx.storage.threadMutationIntents.compareAndSet(intent.id, null, intent);
                if (!result.applied)
                    throw Error("Mutation intent collision");
            }
            catch (error) {
                const saved = await ctx.storage.threadMutationIntents.get(intent.id);
                if (!saved || saved.threadId !== threadId)
                    throw error;
            }
            guard.intents.push(intent);
            let fencedSuccessfully = false;
            for (let attempt = 0; attempt < 8; attempt++) {
                // Discover AFTER registering; callers' previous source reads are not fences.
                const projection = await makeThreadIndex(ctx, threadId);
                if (!projection) {
                    fencedSuccessfully = true;
                    break;
                }
                const head = await ctx.storage.messages.getVersioned(projection.latestId);
                if (!head || (await makeThreadIndex(ctx, threadId))?.latestId !== projection.latestId)
                    continue;
                const fenced = await ctx.storage.messages.compareAndSet(projection.latestId, head.revision, { ...head.value });
                if (fenced.applied) {
                    fencedSuccessfully = true;
                    guard.heads.set(threadId, { id: projection.latestId, receivedAt: head.value.receivedAt });
                    break;
                }
                if (attempt === 7)
                    throw Error("Conversation changed repeatedly while fencing mutation");
            }
            if (!fencedSuccessfully)
                throw Error("Conversation changed repeatedly while fencing mutation");
        }
    }
    catch (error) {
        // Only harmless head fences have run; no action can resume after this rejection.
        await endThreadMutation(ctx, guard);
        throw error;
    }
    return guard;
}
/** Call only after every source write has a known outcome, never in an unconditional finally. */
export async function endThreadMutation(ctx: any, guard: MutationGuard): Promise<void> {
    for (const intent of guard.intents) {
        try {
            const current = await ctx.storage.threadMutationIntents.getVersioned(intent.id);
            if (current)
                await ctx.storage.threadMutationIntents.compareAndDelete(intent.id, current.revision);
        }
        catch {
            // Completed source writes stay successful; a surviving intent conservatively excludes bulk.
            ctx.log?.warn?.("Mutation completed; intent cleanup pending", { intentId: intent.id, threadId: intent.threadId });
        }
    }
}
export async function hasThreadMutation(ctx: any, threadId: string): Promise<boolean> {
    return (await ctx.storage.threadMutationIntents.query({ where: { threadId }, limit: 1 })).items.length > 0;
}
/** Admission is immutable and sampled after acknowledged real publication, never before insertion. */
export async function finishMessageAdmission(ctx: any, id: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
        const row = await ctx.storage.messages.getVersioned(id);
        if (!row || row.value.status === "draft" || row.value.status === "outbox" || row.value.admittedAt)
            return;
        const admittedAt = new Date().toISOString();
        try {
            if ((await ctx.storage.messages.compareAndSet(id, row.revision, { ...row.value, admittedAt, publicationPending: false })).applied)
                return;
        }
        catch (error) {
            if ((await ctx.storage.messages.get(id))?.admittedAt)
                return;
            throw error;
        }
    }
    throw Error("Admission stamp changed repeatedly");
}
