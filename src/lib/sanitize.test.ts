import { describe, it, expect } from "vitest";
import { sanitizeEmailHtml } from "./sanitize";

describe("sanitizeEmailHtml", () => {
	const blocked = { allowExternalImages: false };
	const allowed = { allowExternalImages: true };

	it("strips <script> tags", () => {
		const out = sanitizeEmailHtml("<p>hi</p><script>alert(1)</script>", blocked);
		expect(out).not.toMatch(/<script/i);
		expect(out).toContain("hi");
	});

	it("strips inline event handlers", () => {
		const out = sanitizeEmailHtml('<div onclick="alert(1)">x</div>', blocked);
		expect(out).not.toMatch(/onclick/i);
		expect(out).toContain("x");
	});

	it("blanks external image src when images are blocked", () => {
		const out = sanitizeEmailHtml('<img src="https://tracker.example/x.png">', blocked);
		expect(out).not.toMatch(/tracker\.example/);
	});

	it("keeps external image src when images are allowed", () => {
		const out = sanitizeEmailHtml('<img src="https://example.com/logo.png">', allowed);
		expect(out).toMatch(/example\.com\/logo\.png/);
	});

	it("always preserves data: URI images", () => {
		const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
		expect(sanitizeEmailHtml(html, blocked)).toMatch(/data:image/);
		expect(sanitizeEmailHtml(html, allowed)).toMatch(/data:image/);
	});

	it("always preserves cid: URI images", () => {
		const html = '<img src="cid:inline-logo">';
		expect(sanitizeEmailHtml(html, blocked)).toMatch(/cid:inline-logo/);
		expect(sanitizeEmailHtml(html, allowed)).toMatch(/cid:inline-logo/);
	});

	it("adds rel attributes to external http(s) links", () => {
		const out = sanitizeEmailHtml('<a href="https://example.com">x</a>', blocked);
		expect(out).toMatch(/rel="noopener noreferrer nofollow"/);
	});

	it("does not add rel to mailto: links", () => {
		const out = sanitizeEmailHtml('<a href="mailto:foo@bar.com">x</a>', blocked);
		expect(out).not.toMatch(/rel=/);
	});

	it("preserves benign formatting", () => {
		const html = "<p><strong>hi</strong> <em>world</em></p><ul><li>a</li></ul>";
		const out = sanitizeEmailHtml(html, blocked);
		expect(out).toContain("<strong>");
		expect(out).toContain("<em>");
		expect(out).toContain("<ul>");
		expect(out).toContain("<li>");
	});
});
