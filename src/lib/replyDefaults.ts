import { sanitizeComposeHtml } from "./sanitize";

export interface ReplyDefaultsInput {
	direction: "inbound" | "outbound";
	from: string;
	to: string;
	subject: string;
	bodyText: string;
	bodyHtml: string | null;
	receivedAt: string;
}

export interface ReplyDefaultsOutput {
	to: string;
	subject: string;
	quoteHtml: string;
}

const RE_PREFIX = /^\s*(?:re\s*:\s*)+/i;

function replySubject(original: string): string {
	const trimmed = original.trim();
	if (trimmed === "") return "Re: (no subject)";
	const stripped = trimmed.replace(RE_PREFIX, "").trim();
	const base = stripped === "" ? "(no subject)" : stripped;
	return `Re: ${base}`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function plainTextToHtml(text: string): string {
	return `<p>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</p>`;
}

function formatQuoteDate(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleString(undefined, {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function replyDefaults(row: ReplyDefaultsInput): ReplyDefaultsOutput {
	const to = row.direction === "inbound" ? row.from : row.to;
	const subject = replySubject(row.subject);

	const sender = row.direction === "inbound" ? row.from : row.to;
	const header = `On ${formatQuoteDate(row.receivedAt)}, ${escapeHtml(sender)} wrote:`;

	const quotedBody = row.bodyHtml
		? sanitizeComposeHtml(row.bodyHtml)
		: plainTextToHtml(row.bodyText);

	// Empty leading <p> gives the user a blank paragraph at document start —
	// editor.commands.focus("start") then puts the cursor inside it, so typing
	// doesn't disturb the "On X wrote:" attribution line below.
	const quoteHtml = `<p></p><p>${header}</p><blockquote>${quotedBody}</blockquote>`;

	return { to, subject, quoteHtml };
}
