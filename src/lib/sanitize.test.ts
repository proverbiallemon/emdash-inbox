import { describe, it, expect } from "vitest";
import { sanitizeEmailHtml, sanitizeComposeHtml } from "./sanitize";

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

describe("sanitizeComposeHtml", () => {
	it("passes the StarterKit element set through unchanged", () => {
		const html =
			"<p>para</p>" +
			"<p><strong>b</strong> <em>i</em> <s>s</s> <code>c</code></p>" +
			"<ul><li>a</li></ul>" +
			"<ol><li>b</li></ol>" +
			"<blockquote><p>quoted</p></blockquote>" +
			"<h1>h1</h1><h2>h2</h2><h3>h3</h3>" +
			"<pre><code>x</code></pre>" +
			"<hr>";
		const out = sanitizeComposeHtml(html);
		expect(out).toContain("<strong>b</strong>");
		expect(out).toContain("<em>i</em>");
		expect(out).toContain("<ul>");
		expect(out).toContain("<ol>");
		expect(out).toContain("<blockquote>");
		expect(out).toContain("<h1>h1</h1>");
		expect(out).toContain("<pre>");
		expect(out).toContain("<code>");
		expect(out).toMatch(/<hr\s*\/?>/);
	});

	it("strips <script> while preserving surrounding content", () => {
		const out = sanitizeComposeHtml("<p>before</p><script>alert(1)</script><p>after</p>");
		expect(out).not.toMatch(/<script/i);
		expect(out).toContain("before");
		expect(out).toContain("after");
	});

	it("strips <img> regardless of src", () => {
		const data =
			'<p>x</p><img src="https://tracker.example/x.png"><img src="data:image/png;base64,iVBOR=">';
		const out = sanitizeComposeHtml(data);
		expect(out).not.toMatch(/<img/i);
		expect(out).toContain("x");
	});

	it("adds rel attributes to external http(s) links", () => {
		const out = sanitizeComposeHtml('<a href="https://example.com">link</a>');
		expect(out).toMatch(/rel="noopener noreferrer nofollow"/);
	});

	it("does not add rel to mailto: links", () => {
		const out = sanitizeComposeHtml('<a href="mailto:foo@bar.com">link</a>');
		expect(out).not.toMatch(/rel=/);
	});

	it("strips javascript: hrefs", () => {
		const out = sanitizeComposeHtml('<a href="javascript:alert(1)">x</a>');
		expect(out).not.toMatch(/javascript:/i);
	});

	it("returns empty string for empty input", () => {
		expect(sanitizeComposeHtml("")).toBe("");
	});
});
