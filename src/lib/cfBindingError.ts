/// <reference path="./cfBindingError.d.ts" />

/**
 * Shape of the Cloudflare Email Sending Workers binding (env.EMAIL).
 * The structured send() accepts to/from/subject/html/text plus optional
 * cc/bcc/replyTo, attachments, and headers; returns { messageId } on success.
 *
 * Narrowed here to what `deliverEmail()` actually uses. If we extend our
 * use later (attachments, replyTo), expand this type rather than relaxing
 * to Record<string, unknown>.
 */
export interface EmailAttachment {
	// Keep this narrower than the provider union: attachment content is always
	// the original bytes, never a base64 string requiring implicit decoding.
	content: ArrayBuffer;
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}

export interface EmailBinding {
	send(payload: {
		to: string | string[];
		from: string;
		subject: string;
		text?: string;
		html?: string;
		cc?: string[];
		bcc?: string[];
		headers?: Record<string, string>;
		attachments?: EmailAttachment[];
	}): Promise<{ messageId?: string }>;
}

/**
 * Domain-classified delivery error. Distinguishable by the route caller from
 * generic JS errors so it can surface the message verbatim via
 * `PluginRouteError.badRequest` — emdash strips messages from
 * `PluginRouteError.internal` on the wire, so unknown errors get a generic
 * code while these get the operator-actionable text.
 */
export class DeliverError extends Error {
	constructor(message: string, readonly definitive = false, readonly code?: string) {
		super(message);
		this.name = "DeliverError";
	}
}

// Only documented pre-acceptance rejections permit restoring an editable draft.
// Message text is not evidence: a timeout can contain any of these words.
const definitiveCodes = new Set([
	"E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS", "E_TOO_MANY_ATTACHMENTS",
	"E_SENDER_NOT_VERIFIED", "E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED",
	"E_SENDER_DOMAIN_NOT_AVAILABLE", "E_CONTENT_TOO_LARGE", "E_RATE_LIMIT_EXCEEDED",
	"E_DAILY_LIMIT_EXCEEDED", "E_HEADER_NOT_ALLOWED", "E_HEADER_USE_API_FIELD",
	"E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG", "E_HEADER_NAME_INVALID",
	"E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY", "SENDER_NOT_VERIFIED",
]);

/**
 * Map an unknown thrown error from `env.EMAIL.send()` into a `DeliverError`
 * with a message a non-developer operator can act on.
 *
 * The CF Email binding throws errors with a `.code` field. We pattern-match
 * on known codes and surface setup guidance; falling back to the original
 * message for unknowns so we don't swallow useful context.
 */
export function wrapBindingError(err: unknown): DeliverError {
	if (err instanceof DeliverError) return err;

	const message = err instanceof Error ? err.message : String(err ?? "unknown error");
	const candidate = err && typeof err === "object" && "code" in err ? err.code : undefined;
	const code = typeof candidate === "string" ? candidate : undefined;
	const definitive = code !== undefined && definitiveCodes.has(code);

	if (code === "SENDER_NOT_VERIFIED" || /sender.*not.*verified|verify.*sender/i.test(message)) {
		return new DeliverError(
			`emdash-inbox: sender domain not verified in Cloudflare Email Service. Onboard your domain at Dashboard → Compute & AI → Email Service → Email Sending → Onboard Domain. (${message})`,
			definitive, code,
		);
	}

	if (code === "EMAIL_BINDING_MISSING" || /EMAIL binding missing|wrangler/i.test(message)) {
		return new DeliverError(
			`emdash-inbox: env.EMAIL binding unavailable — check the host's wrangler.jsonc has \`send_email: [{ name: "EMAIL" }]\`. (${message})`,
			definitive, code,
		);
	}

	return new DeliverError(`emdash-inbox: CF Email binding send failed — ${message}`, definitive, code);
}
