import { PluginRouteError, type RouteContext } from "emdash";
import { defaultSignature, isEmailSignature, type EmailSignature } from "./signature";
import { normalizeSignatureMarkup } from "./signatureMarkup";

export async function readSignature(ctx: Pick<RouteContext, "user" | "kv">) {
	const stored = ctx.user ? await ctx.kv.get<EmailSignature>(`signature:${encodeURIComponent(ctx.user.id)}`) : null;
	return { signature: stored ?? { ...defaultSignature }, canSave: Boolean(ctx.user) };
}

export async function saveSignature(ctx: Pick<RouteContext, "user" | "kv" | "input">) {
	if (!ctx.user) throw PluginRouteError.forbidden("Sign in as a user to save your email signature.");
	if (!isEmailSignature(ctx.input)) throw PluginRouteError.badRequest("Enter a signature of at most 10,000 characters and choose when to include it.");
	const signature: EmailSignature = {
		text: ctx.input.text.replace(/\r\n?/g, "\n").trim(),
		newMessages: ctx.input.newMessages,
		replies: ctx.input.replies,
	};
	if (ctx.input.html !== undefined) {
		try { Object.assign(signature, normalizeSignatureMarkup(ctx.input.html)); }
		catch (error) { throw PluginRouteError.badRequest(error instanceof Error ? error.message : "Invalid signature formatting"); }
	}
	await ctx.kv.set(`signature:${encodeURIComponent(ctx.user.id)}`, signature);
	return { signature };
}
