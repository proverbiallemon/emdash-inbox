import { describe, it, expect } from "vitest";
import { prepareEmailHtml, sanitizeEmailHtml, sanitizeComposeHtml } from "./sanitize";

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

	it.each([
		'<img srcset="https://tracker.example/pixel.png 1x, //tracker.example/pixel@2x.png 2x">',
		'<picture><source srcset="https://tracker.example/pixel.png"><img alt="logo"></picture>',
		'<svg><image href="https://tracker.example/pixel.png" /></svg>',
		'<svg><image xlink:href="https://tracker.example/pixel.png" /></svg>',
		'<table background="https://tracker.example/pixel.png"><tr><td>hello</td></tr></table>',
		'<video poster="https://tracker.example/pixel.png"><source src="https://tracker.example/movie"></video>',
		'<audio src="https://tracker.example/audio" autoplay></audio>',
		'<iframe src="https://tracker.example/frame"></iframe><object data="https://tracker.example/object"></object>',
		'<link rel="stylesheet" href="https://tracker.example/style.css"><link rel="preload" href="https://tracker.example/font">',
	])("removes automatic resource loading outside img src: %s", (html) => {
		for (const options of [blocked, allowed]) {
			const out = sanitizeEmailHtml(html, options);
			expect(out).not.toContain("tracker.example");
			expect(out).not.toMatch(/<(?:svg|image|source|video|audio|iframe|object|link)\b/i);
		}
	});

	it.each([
		'<p style="background-image: url(https://tracker.example/pixel)">hello</p>',
		String.raw`<p style="background: u\72l(https://tracker.example/pixel)">hello</p>`,
		'<p>hello</p><style>@import "https://tracker.example/theme.css"; body { display: none }</style>',
		String.raw`<p>hello</p><style>@\69mport "https://tracker.example/theme.css"; body { display: none }</style>`,
	])("removes CSS loading and page-wide styling in both image modes: %s", (html) => {
		for (const options of [blocked, allowed]) {
			const out = sanitizeEmailHtml(html, options);
			expect(out).not.toMatch(/<style\b|\sstyle=/i);
			expect(out).not.toContain("tracker.example");
			expect(out).toContain("hello");
		}
	});

	it("removes classes and IDs that could activate admin page styles", () => {
		const out = sanitizeEmailHtml('<div id="admin" class="fixed inset-0">hello</div>', blocked);
		expect(out).not.toMatch(/\s(?:id|class)=/);
		expect(out).toContain("hello");
	});

	it.each(["//tracker.example/pixel.png", "/pixel.png", "pixel.png", "https&#58;//tracker.example/pixel.png"])(
		"requires opt-in for browser-resolved image URL %s", (src) => {
			const html = `<img src="${src}" alt="logo">`;
			expect(sanitizeEmailHtml(html, blocked)).not.toMatch(/\ssrc=/);
			expect(sanitizeEmailHtml(html, allowed)).toMatch(/\ssrc=/);
		},
	);

	it.each([
		"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E",
		"data:text/html;base64,PHNjcmlwdD4=",
		"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
	])("does not allow active or non-raster inline image payloads: %s", (src) => {
		for (const options of [blocked, allowed]) {
			expect(sanitizeEmailHtml(`<img src="${src}">`, options)).not.toMatch(/\ssrc=/);
		}
	});

	it("preserves table structure and safe formatting attributes", () => {
		const html = '<table cellpadding="4" cellspacing="0"><tbody><tr><td colspan="2" align="center"><strong>Receipt</strong></td></tr></tbody></table>';
		const out = sanitizeEmailHtml(html, blocked);
		expect(out).toContain('<table cellpadding="4" cellspacing="0">');
		expect(out).toContain('<td colspan="2" align="center">');
		expect(out).toContain("<strong>Receipt</strong>");
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

describe("prepareEmailHtml image-reveal metadata", () => {
	it.each([
		"https://tracker.example/pixel.png",
		"//tracker.example/pixel.png",
		"/pixel.png",
		"pixel.png",
		"https&#58;//tracker.example/pixel.png",
	])("offers image reveal for a sanitized external src: %s", (src) => {
		const raw = `<img src="${src}" alt="logo">`;
		const hidden = prepareEmailHtml(raw, { allowExternalImages: false });
		const visible = prepareEmailHtml(raw, { allowExternalImages: true });
		expect(hidden.hasExternalImages).toBe(true);
		expect(hidden.html).not.toMatch(/\ssrc=/);
		expect(visible.hasExternalImages).toBe(true);
		expect(visible.html).toMatch(/\ssrc=/);
	});

	it.each([
		'<img src="cid:inline-logo">',
		'<img src="data:image/png;base64,iVBORw0KGgo=">',
		'<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
		'<img src="javascript:alert(1)">',
		'<img srcset="https://tracker.example/pixel.png 2x">',
		'<img data-src="https://tracker.example/pixel.png">',
		'<!-- <img src="https://tracker.example/pixel.png"> -->',
		'<div title=\'<img src="https://tracker.example/pixel.png">\'>hello</div>',
		'<svg><image href="https://tracker.example/pixel.png" /></svg>',
	])("does not offer reveal when there is no supported external image: %s", (raw) => {
		expect(prepareEmailHtml(raw, { allowExternalImages: false }).hasExternalImages).toBe(false);
	});
});

describe("sanitizeComposeHtml", () => {
	it("preserves signature typography while rejecting CSS resources and UI overrides", () => {
		const raw = '<p style="text-align:center;position:fixed"><span style="font-family:Georgia,serif;font-size:18px;color:rgb(36, 91, 224);background-color:#fff0e1;background-image:url(https://tracker.example/pixel);display:none">Alex</span></p>';
		for (const out of [sanitizeComposeHtml(raw), sanitizeEmailHtml(raw, { allowExternalImages: false })]) {
			expect(out).toContain("font-family:Georgia,serif"); expect(out).toContain("font-size:18px"); expect(out).toContain("color:rgb(36, 91, 224)"); expect(out).toContain("text-align:center");
			expect(out).not.toMatch(/position|display|tracker|background-image/);
		}
	});
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

	it("strips remote and invalid inline images", () => {
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

	it("strips <img> even inside HTML comments", () => {
		const out = sanitizeComposeHtml("<!--<img src=x>--><p>hi</p>");
		expect(out).not.toMatch(/<img/i);
	});

	it("strips <img> even with > inside quoted attributes", () => {
		const out = sanitizeComposeHtml('<img src="x>y" alt="z"><p>after</p>');
		expect(out).not.toMatch(/<img/i);
		expect(out).toContain("after");
	});
});
