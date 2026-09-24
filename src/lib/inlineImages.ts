import { Parser } from "htmlparser2";
import { decodeSignatureImage } from "./signatureImage";
import { AttachmentError } from "./attachments";
import type { EmailAttachment } from "./cfBindingError";

function escape(value: string) { return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/** Convert uploaded raster images to portable MIME parts without changing the
 * persisted body. Drafts/history retain their self-contained image copies. */
export async function embedInlineImages(html = ""): Promise<{ html: string; attachments: EmailAttachment[] }> {
	const images: { start: number; end: number; attrs: Record<string, string> }[] = [];
	const parser = new Parser({ onopentag(tag, attrs) {
		if (tag === "img" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(attrs.src ?? "")) images.push({ start: parser.startIndex, end: parser.endIndex + 1, attrs });
	} });
	parser.end(html);
	if (images.length > 32) throw new AttachmentError("bad_request", "At most 32 inline images are supported.");
	const parts = new Map<string, EmailAttachment>();
	let result = ""; let offset = 0;
	for (const image of images) {
		let decoded;
		try { decoded = decodeSignatureImage(image.attrs.src)!; }
		catch (error) { throw new AttachmentError("bad_request", error instanceof Error ? error.message : "Invalid inline image"); }
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(decoded.bytes).buffer));
		const contentId = `inbox-${[...digest].map(byte => byte.toString(16).padStart(2, "0")).join("")}@signature`;
		if (!parts.has(contentId)) parts.set(contentId, { content: new Uint8Array(decoded.bytes).buffer, type: decoded.type, filename: `signature-${parts.size + 1}.${decoded.type.split("/")[1]}`, disposition: "inline", contentId });
		const attrs = { ...image.attrs, src: `cid:${contentId}` };
		result += html.slice(offset, image.start) + `<img${Object.entries(attrs).filter(([name]) => ["src", "alt", "title", "width", "height"].includes(name)).map(([name,value]) => ` ${name}="${escape(value)}"`).join("")}>`;
		offset = image.end;
	}
	return { html: result + html.slice(offset), attachments: [...parts.values()] };
}
