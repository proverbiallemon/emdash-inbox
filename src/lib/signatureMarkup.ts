import sanitizeHtml from "sanitize-html";
import { Parser } from "htmlparser2";
import { safeMailStyle } from "./mailStyles";
import { decodeSignatureImage, MAX_SIGNATURE_IMAGE_BYTES } from "./signatureImage";
import { MAX_SIGNATURE_LENGTH, MAX_SIGNATURE_HTML_LENGTH } from "./signature";

/** Server-side normalization for stored rich signatures. */
export function normalizeSignatureMarkup(raw: string): { html: string; text: string } {
	if (raw.length > MAX_SIGNATURE_HTML_LENGTH) throw new Error("The formatted signature is too large. Shorten it or use a smaller logo.");
	let imageBytes = 0;
	let imageCount = 0;
	const html = sanitizeHtml(raw, {
		allowedTags: ["p", "br", "span", "strong", "b", "em", "i", "u", "s", "strike", "ul", "ol", "li", "blockquote", "a", "h1", "h2", "h3", "hr", "img"],
		allowedAttributes: { "*": ["style"], a: ["href", "rel"], img: ["src", "alt", "title", "width", "height"] },
		allowedSchemes: ["http", "https", "mailto", "tel"], allowedSchemesByTag: { img: ["data"] }, allowProtocolRelative: false,
		parseStyleAttributes: false, nestingLimit: 12,
		transformTags: { "*": (tag, attributes) => {
			const attribs: Record<string, string> = { ...attributes, style: safeMailStyle(attributes.style) };
			if (tag === "a") attribs.rel = "noopener noreferrer nofollow";
			if (tag === "img") {
				const image = decodeSignatureImage(attributes.src ?? "");
				if (!image) delete attribs.src;
				else { imageBytes += image.bytes.length; imageCount++; }
				for (const name of ["width", "height"]) if (!/^\d{1,3}$/.test(attribs[name] ?? "") || Number(attribs[name]) > 600 || Number(attribs[name]) < 1) delete attribs[name];
			}
			if (!attribs.style) delete attribs.style;
			return { tagName: tag === "div" ? "p" : tag, attribs };
		} },
		exclusiveFilter: frame => frame.tag === "img" && !frame.attribs.src,
	});
	if (html.length > MAX_SIGNATURE_HTML_LENGTH) throw new Error("The formatted signature is too large. Shorten it or use a smaller logo.");
	if (imageCount > 32) throw new Error("A signature can contain at most 32 images.");
	if (imageBytes > MAX_SIGNATURE_IMAGE_BYTES) throw new Error("Signature images must total at most 64 KiB. Use a smaller logo.");
	const parts: string[] = [];
	const parser = new Parser({ ontext: text => parts.push(text), onopentag: (tag, attrs) => { if (tag === "br") parts.push("\n"); if (tag === "img" && attrs.alt) parts.push(attrs.alt); }, onclosetag: tag => { if (["p", "li", "blockquote", "h1", "h2", "h3"].includes(tag)) parts.push("\n"); } });
	parser.end(html);
	const text = parts.join("").replace(/\n{3,}/g, "\n\n").trim();
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error("Remove unsupported control characters from your signature.");
	if (text.length > MAX_SIGNATURE_LENGTH) throw new Error("Signature text must be at most 10,000 characters.");
	return { html: text || imageBytes ? html : "", text };
}
