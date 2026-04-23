import { describe, it, expect } from "vitest";
import { replyDefaults } from "./replyDefaults";

const baseRow = {
	direction: "inbound" as const,
	from: "alice@example.com",
	to: "me@mysite.com",
	subject: "Hello there",
	bodyText: "Hi!\nLine two.",
	bodyHtml: null as string | null,
	receivedAt: "2026-04-21T14:30:00.000Z",
};

describe("replyDefaults", () => {
	it("inbound: replies to the sender", () => {
		const out = replyDefaults({ ...baseRow });
		expect(out.to).toBe("alice@example.com");
	});

	it("outbound: replies to the original recipient", () => {
		const out = replyDefaults({ ...baseRow, direction: "outbound" });
		expect(out.to).toBe("me@mysite.com");
	});

	it("preserves an existing 'Re:' prefix without doubling", () => {
		const out = replyDefaults({ ...baseRow, subject: "Re: Hello" });
		expect(out.subject).toBe("Re: Hello");
	});

	it("normalizes uppercase 'RE:' to canonical 'Re:'", () => {
		const out = replyDefaults({ ...baseRow, subject: "RE: Hello" });
		expect(out.subject).toBe("Re: Hello");
	});

	it("collapses 'Re: Re: Re:' chains down to a single prefix", () => {
		const out = replyDefaults({ ...baseRow, subject: "Re: Re: Re: Hello" });
		expect(out.subject).toBe("Re: Hello");
	});

	it("uses '(no subject)' fallback for empty subjects", () => {
		const out = replyDefaults({ ...baseRow, subject: "" });
		expect(out.subject).toBe("Re: (no subject)");
	});

	it("adds a 'Re:' prefix to a bare subject", () => {
		const out = replyDefaults({ ...baseRow, subject: "Hello" });
		expect(out.subject).toBe("Re: Hello");
	});

	it("quoteHtml wraps bodyText in <p> when bodyHtml is null", () => {
		const out = replyDefaults({ ...baseRow });
		expect(out.quoteHtml).toContain("<blockquote>");
		expect(out.quoteHtml).toContain("alice@example.com");
		expect(out.quoteHtml).toContain("Hi!");
		// newline preservation in plain-text fallback
		expect(out.quoteHtml).toMatch(/Hi!.*<br>.*Line two\./s);
	});

	it("quoteHtml uses sanitized bodyHtml when present", () => {
		const out = replyDefaults({
			...baseRow,
			bodyHtml: "<p>Greetings <strong>friend</strong></p>",
		});
		expect(out.quoteHtml).toContain("<blockquote>");
		expect(out.quoteHtml).toContain("<strong>friend</strong>");
	});

	it("quoteHtml strips <script> from bodyHtml via sanitizeComposeHtml", () => {
		const out = replyDefaults({
			...baseRow,
			bodyHtml: "<p>Hi</p><script>alert(1)</script>",
		});
		expect(out.quoteHtml).not.toMatch(/<script/i);
		expect(out.quoteHtml).toContain("Hi");
	});

	it("quoteHtml header line names sender + formatted date", () => {
		const out = replyDefaults({ ...baseRow });
		expect(out.quoteHtml).toMatch(/On .*alice@example\.com wrote:/);
	});
});
