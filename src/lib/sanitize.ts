import DOMPurify from "dompurify";

const INLINE_URI = /^(?:cid:[^\s]+|data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+)$/i;
const HTTP_URI = /^https?:/i;

// Email markup is rendered in the admin document, so source CSS and other
// resource-loading elements cannot be made safe by filtering img.src alone.
const EMAIL_ALLOWED_TAGS = [
	"body", "a", "abbr", "address", "b", "bdi", "bdo", "blockquote", "br",
	"caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "div",
	"dl", "dt", "em", "figcaption", "figure", "font", "h1", "h2", "h3", "h4",
	"h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre",
	"q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "table",
	"tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "var", "wbr",
];

const EMAIL_ALLOWED_ATTR = [
	"href", "src", "alt", "title", "width", "height", "align", "valign", "border",
	"cellpadding", "cellspacing", "colspan", "rowspan", "bgcolor", "color", "face",
	"size", "dir", "lang", "start", "reversed", "scope",
];

/**
 * Sanitize HTML from an inbound email for safe rendering in the admin.
 *
 * Keeps structural formatting and table layout, with no source CSS, classes,
 * IDs, SVG, media, embedded documents, or responsive image sources. This
 * prevents network loading and source styles from affecting the admin page.
 * Only img.src may load a resource: raster data: and cid: images are kept;
 * external images require allowExternalImages. DOMPurify still rejects unsafe
 * protocols. External http(s) links gain rel="noopener noreferrer nofollow".
 *
 * Returns a safe HTML string intended for dangerouslySetInnerHTML on a
 * plain <div>. Removing CSS intentionally sacrifices some email styling.
 */
export function sanitizeEmailHtml(
	raw: string,
	opts: { allowExternalImages: boolean },
): string {
	return prepareEmailHtml(raw, opts).html;
}

/** Prepare the email body and the image-reveal banner in one sanitization pass. */
export function prepareEmailHtml(
	raw: string,
	opts: { allowExternalImages: boolean },
): { html: string; hasExternalImages: boolean } {
	let hasExternalImages = false;
	// Clean up any hooks from prior invocations in the same session.
	DOMPurify.removeAllHooks();

	DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
		if (data.attrName === "src" && node.nodeName !== "IMG") {
			data.keepAttr = false;
		}
		if (data.attrName === "href" && node.nodeName !== "A") {
			data.keepAttr = false;
		}
	});

	DOMPurify.addHook("afterSanitizeAttributes", (node) => {
		if (node.nodeName === "IMG") {
			const image = node as Element;
			const src = image.getAttribute("src");
			if (src !== null && !INLINE_URI.test(src)) {
				// DOMPurify has already decoded attributes and rejected unsafe
				// protocols. Unsupported inline payloads never become revealable.
				const external = src !== "" && !/^(?:data|cid):/i.test(src);
				hasExternalImages ||= external;
				if (!external || !opts.allowExternalImages) image.removeAttribute("src");
			}
		}
		if (node.nodeName === "A") {
			const href = (node as Element).getAttribute("href") ?? "";
			if (HTTP_URI.test(href)) {
				(node as Element).setAttribute("rel", "noopener noreferrer nofollow");
			}
		}
	});

	try {
		const html = DOMPurify.sanitize(raw, {
			ALLOWED_TAGS: EMAIL_ALLOWED_TAGS,
			ALLOWED_ATTR: EMAIL_ALLOWED_ATTR,
			ALLOW_DATA_ATTR: false,
			ALLOW_ARIA_ATTR: false,
		});
		return { html, hasExternalImages };
	} finally {
		DOMPurify.removeAllHooks();
	}
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
