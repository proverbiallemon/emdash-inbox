import * as React from "react";
import { getSignature } from "./signatureClient";
import { plainTextToHtml } from "./replyDefaults";
import { sanitizeComposeHtml } from "./sanitize";

/** Seed a fresh editor once; persisted drafts never consult the signature. */
export function useComposeSignature(kind: "newMessages" | "replies" | null, quoteHtml = "") {
	const [quote] = React.useState(quoteHtml);
	const [html, setHtml] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [attempt, retry] = React.useReducer(value => value + 1, 0);
	const [skipped, setSkipped] = React.useState(false);
	React.useEffect(() => {
		if (!kind || skipped) return;
		let cancelled = false;
		setError(null);
		void getSignature().then(({ signature }) => {
			if (cancelled) return;
			// Keep a blank paragraph above the signature for writing. The reply
			// attribution and quote follow it; signature text is never raw HTML.
			const body = signature.html !== undefined ? sanitizeComposeHtml(signature.html) : signature.text.trim() ? plainTextToHtml(signature.text) : "";
			setHtml(signature[kind] && body
				? `<p></p>${body}${quote.replace(/^<p><\/p>/, "")}`
				: quote);
		}).catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)); });
		return () => { cancelled = true; };
	}, [kind, quote, attempt, skipped]);
	return { html: skipped ? quote : html, error: skipped ? null : error, retry, skip: () => setSkipped(true) };
}
