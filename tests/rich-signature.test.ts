// @vitest-environment node
import { expect, it } from "vitest";
import { normalizeSignatureMarkup } from "../src/lib/signatureMarkup";
import { embedInlineImages } from "../src/lib/inlineImages";
import { saveSignature } from "../src/lib/signatureSettings";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
it("stores safe fonts, colors, alignment, links and logos while removing active or resource-loading markup", async () => {
	let stored: any;
	const html = `<p style="text-align:center;position:fixed"><strong><span style="font-family:Georgia,serif;font-size:18px;color:#245be0;background-color:#fff0e1;background:url(https://tracker.example/pixel)">Alex &amp; Co</span></strong></p><p><a href="https://example.com" onclick="bad()">Website</a><img src="data:image/png;base64,${png}" width="120" alt="Studio logo"></p><script>bad()</script><style>body{display:none}</style><img src="https://tracker.example/pixel">`;
	await saveSignature({ user: { id: "owner" }, kv: { set: async (_key: string, value: unknown) => { stored = value; } }, input: { text: "stale fallback", html, newMessages: true, replies: true } } as any);
	expect(stored.html).toContain("font-family:Georgia,serif"); expect(stored.html).toContain("font-size:18px"); expect(stored.html).toContain("color:#245be0"); expect(stored.html).toContain("background-color:#fff0e1"); expect(stored.html).toContain("text-align:center");
	expect(stored.html).toContain(`data:image/png;base64,${png}`); expect(stored.html).toContain('href="https://example.com"');
	expect(stored.html).not.toMatch(/script|onclick|position|tracker|<style/); expect(stored.text).toContain("Alex & Co"); expect(stored.text).toContain("Website"); expect(stored.text).not.toContain("stale fallback");
});
it("rejects oversized or disguised uploaded images and does not preserve external image URLs", () => {
	for (const src of ["data:image/png;base64,PHN2Zz48L3N2Zz4=", `data:image/png;base64,${"A".repeat(100000)}`]) expect(() => normalizeSignatureMarkup(`<img src="${src}">`)).toThrow();
	expect(normalizeSignatureMarkup('<p>Alex</p><img src="https://tracker.example/pixel"><img src="data:image/svg+xml;base64,PHN2Zz4=">').html).not.toContain("<img");
	expect(normalizeSignatureMarkup("<p><br></p>")).toEqual({ html: "", text: "" });
});
it("embeds duplicate logos once with matching Content-IDs and exact original bytes", async () => {
	const html = `<p style="color:#245be0">Hello</p><img src="data:image/png;base64,${png}" alt="Logo"><blockquote><img src='data:image/png;base64,${png}'></blockquote>`;
	const result = await embedInlineImages(html);
	expect(result.attachments).toHaveLength(1);
	expect(result.attachments[0]).toMatchObject({ disposition: "inline", type: "image/png" });
	expect(Buffer.from(result.attachments[0].content).toString("base64")).toBe(png);
	expect(result.html.match(/src="cid:/g)).toHaveLength(2);
	expect(result.html).toContain(`cid:${result.attachments[0].contentId}`); expect(result.html).not.toContain("data:image");
	expect(result.html).toContain('style="color:#245be0"');
	expect((await embedInlineImages(html)).attachments[0].contentId).toBe(result.attachments[0].contentId);
});

it.each([
	`<p>Alex&#1;</p>`,
	`<p>${'<a href="https://example.com">A</a>'.repeat(2000)}</p>`,
	`<p>${`<img src="data:image/png;base64,${png}">`.repeat(33)}</p>`,
])("rejects signatures whose normalized content cannot be safely loaded or sent (%#)", html => {
	expect(() => normalizeSignatureMarkup(html)).toThrow();
});
