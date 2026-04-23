import DOMPurify from "dompurify";

const INLINE_URI = /^(data|cid):/i;
const HTTP_URI = /^https?:/i;

/**
 * Sanitize HTML from an inbound email for safe rendering in the admin.
 *
 * Strips scripts, event handlers, dangerous protocols (DOMPurify defaults),
 * plus two email-specific rules:
 *   1. External image src attributes are blanked unless caller opts in via
 *      allowExternalImages. Inline images (data: / cid:) are always kept.
 *   2. External http(s) <a> links gain rel="noopener noreferrer nofollow".
 *      mailto: and other schemes are left alone.
 *
 * Returns a safe HTML string intended for dangerouslySetInnerHTML on a
 * plain <div>. No iframe isolation — inline styles from the source email
 * may affect layout. Iframe sandboxing is a future polish.
 */
export function sanitizeEmailHtml(
	raw: string,
	opts: { allowExternalImages: boolean },
): string {
	// Clean up any hooks from prior invocations in the same session.
	DOMPurify.removeAllHooks();

	DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
		if (
			data.attrName === "src" &&
			!INLINE_URI.test(data.attrValue) &&
			!opts.allowExternalImages
		) {
			data.keepAttr = false;
		}
	});

	DOMPurify.addHook("afterSanitizeAttributes", (node) => {
		if (node.nodeName === "A") {
			const href = (node as Element).getAttribute("href") ?? "";
			if (HTTP_URI.test(href)) {
				(node as Element).setAttribute("rel", "noopener noreferrer nofollow");
			}
		}
	});

	const out = DOMPurify.sanitize(raw);
	DOMPurify.removeAllHooks();
	return out;
}

const COMPOSE_ALLOWED_TAGS = [
	"p", "br", "strong", "b", "em", "i", "u", "s", "strike",
	"ul", "ol", "li", "blockquote",
	"h1", "h2", "h3", "h4", "h5", "h6",
	"a", "code", "pre", "hr",
];

const COMPOSE_ALLOWED_ATTR = ["href", "class"];

/**
 * Sanitize HTML produced by the in-app compose editor (TipTap StarterKit) for
 * outbound email send. Different priorities from sanitizeEmailHtml:
 *   - Aggressive allowlist: only TipTap StarterKit's element set survives.
 *   - <img> is stripped unconditionally (StarterKit doesn't emit images;
 *     this catches pasted HTML).
 *   - External http(s) <a> links gain rel="noopener noreferrer nofollow".
 *   - mailto: and other schemes left alone.
 *   - DOMPurify defaults handle scripts, event handlers, and dangerous
 *     protocols (javascript:, data: on anchors).
 *
 * Hooks are scoped per invocation (removeAllHooks() at start AND end), so
 * sanitizeComposeHtml and sanitizeEmailHtml don't interfere across calls.
 */
export function sanitizeComposeHtml(raw: string): string {
	if (raw === "") return "";

	DOMPurify.removeAllHooks();

	DOMPurify.addHook("afterSanitizeAttributes", (node) => {
		if (node.nodeName === "A") {
			const href = (node as Element).getAttribute("href") ?? "";
			if (HTTP_URI.test(href)) {
				(node as Element).setAttribute("rel", "noopener noreferrer nofollow");
			}
		}
	});

	// Pre-strip <img> tags. DOMPurify's KEEP_CONTENT clone-and-reinsert path
	// has a quirk with adjacent same-tag elements (the second img in
	// `<img src="..."><img src="data:...">` survives even FORBID_TAGS in the
	// happy-dom test environment). Removing them up front sidesteps it.
	const stripped = raw.replace(/<img\b[^>]*>/gi, "");

	const out = DOMPurify.sanitize(stripped, {
		ALLOWED_TAGS: COMPOSE_ALLOWED_TAGS,
		ALLOWED_ATTR: COMPOSE_ALLOWED_ATTR,
	});
	DOMPurify.removeAllHooks();
	return out;
}
