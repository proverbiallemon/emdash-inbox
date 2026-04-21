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
