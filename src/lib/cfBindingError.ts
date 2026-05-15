/// <reference path="./cfBindingError.d.ts" />

/**
 * Domain-classified delivery error. Distinguishable by the route caller from
 * generic JS errors so it can surface the message verbatim via
 * `PluginRouteError.badRequest` — emdash strips messages from
 * `PluginRouteError.internal` on the wire, so unknown errors get a generic
 * code while these get the operator-actionable text.
 */
export class DeliverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliverError";
  }
}

/**
 * Map an unknown thrown error from `env.EMAIL.send()` into a `DeliverError`
 * with a message a non-developer operator can act on.
 *
 * The CF Email binding throws errors with a `.code` field (per agentic-inbox's
 * `workers/email-sender.ts`). We pattern-match on known codes and surface
 * setup guidance; falling back to the original message for unknowns so we
 * don't swallow useful context.
 */
export function wrapBindingError(err: unknown): DeliverError {
  if (err instanceof DeliverError) return err;

  const message = err instanceof Error ? err.message : String(err ?? "unknown error");
  const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;

  if (code === "SENDER_NOT_VERIFIED" || /sender.*not.*verified|verify.*sender/i.test(message)) {
    return new DeliverError(
      `emdash-inbox: sender domain not verified in Cloudflare Email Service. Onboard your domain at Dashboard → Compute & AI → Email Service → Email Sending → Onboard Domain. (${message})`,
    );
  }

  if (/EMAIL binding missing|wrangler/i.test(message)) {
    return new DeliverError(
      `emdash-inbox: env.EMAIL binding unavailable — check the host's wrangler.jsonc has \`send_email: [{ name: "EMAIL" }]\`. (${message})`,
    );
  }

  return new DeliverError(`emdash-inbox: CF Email binding rejected send — ${message}`);
}
