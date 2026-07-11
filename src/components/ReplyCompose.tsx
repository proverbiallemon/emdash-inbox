import * as React from "react";
import type { Editor } from "@tiptap/react";
import { apiFetch } from "emdash/plugin-utils";
import { TipTapEditor } from "./TipTapEditor";
import { ComposeToolbar } from "./ComposeToolbar";

const API = "/_emdash/api/plugins/emdash-inbox";

export interface ReplyComposeDefaults {
	to: string;
	cc?: string;
	subject: string;
	quoteHtml: string;
}

interface Props {
	defaults: ReplyComposeDefaults;
	inReplyTo: string;
	threadId: string | null;
	onSent: () => void;
	onDiscard: () => void;
}

/** Extracts the server's `error.message` from a failed response, falling back
 *  to a generic status-code message when the body isn't the expected shape. */
async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as { error?: { message?: string } };
		if (body?.error?.message) return body.error.message;
	} catch {
		// non-JSON body — keep the fallback message
	}
	return fallback;
}

export function ReplyCompose({ defaults, inReplyTo, threadId, onSent, onDiscard }: Props) {
	const [to, setTo] = React.useState(defaults.to);
	const [cc, setCc] = React.useState(defaults.cc ?? "");
	const [subject, setSubject] = React.useState(defaults.subject);
	const [busy, setBusy] = React.useState<"send" | "save" | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [editor, setEditor] = React.useState<Editor | null>(null);
	const [initialSnapshot, setInitialSnapshot] = React.useState<string | null>(null);
	const [abortCtrl, setAbortCtrl] = React.useState<AbortController | null>(null);

	const handleEditorReady = React.useCallback((ed: Editor) => {
		setEditor(ed);
		setInitialSnapshot(ed.getHTML());
		ed.commands.focus("start");
	}, []);

	const isDirty = React.useCallback(() => {
		if (!editor || initialSnapshot === null) return false;
		return editor.getHTML() !== initialSnapshot;
	}, [editor, initialSnapshot]);

	const handleSend = React.useCallback(async () => {
		if (!editor || busy) return;
		setBusy("send");
		setError(null);
		const ctrl = new AbortController();
		setAbortCtrl(ctrl);
		try {
			const html = editor.getHTML();
			const text = editor.getText();
			const res = await apiFetch(`${API}/messages/reply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ inReplyTo, to, cc: cc || undefined, subject, text, html }),
				signal: ctrl.signal,
			});
			if (!res.ok) throw new Error(await extractErrorMessage(res, `send failed (${res.status})`));
			onSent();
		} catch (err) {
			// AbortError fires when the user clicks Discard mid-send/mid-save.
			// Treat as a no-op — the discard handler already calls onDiscard()
			// to close the form, and there's nothing for the user to retry.
			if (err instanceof DOMException && err.name === "AbortError") return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
			setAbortCtrl(null);
		}
	}, [editor, busy, inReplyTo, to, cc, subject, onSent]);

	const handleSaveDraft = React.useCallback(async () => {
		if (!editor || busy) return;
		setBusy("save");
		setError(null);
		const ctrl = new AbortController();
		setAbortCtrl(ctrl);
		try {
			const res = await apiFetch(`${API}/messages/draft-save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					threadId: threadId ?? undefined,
					to,
					cc: cc || undefined,
					subject,
					text: editor.getText(),
					html: editor.getHTML(),
				}),
				signal: ctrl.signal,
			});
			if (!res.ok) throw new Error(await extractErrorMessage(res, `save failed (${res.status})`));
			onDiscard(); // close the form; the draft lives in the Drafts tab now
		} catch (err) {
			// AbortError fires when the user clicks Discard/Cancel mid-save.
			if (err instanceof DOMException && err.name === "AbortError") return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
			setAbortCtrl(null);
		}
	}, [editor, busy, threadId, to, cc, subject, onDiscard]);

	const handleDiscard = React.useCallback(() => {
		// Mid-send or mid-save: cancel whichever request is in flight and close
		// immediately. The user explicitly chose to abandon the operation, so
		// don't confirm — they're already committing to discard by clicking
		// during "Sending…"/"Saving…".
		if (busy) {
			abortCtrl?.abort();
			onDiscard();
			return;
		}
		if (isDirty() && !window.confirm("Discard this reply?")) return;
		onDiscard();
	}, [busy, abortCtrl, isDirty, onDiscard]);

	const onKeyDown = (e: React.KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			void handleSend();
		} else if (e.key === "Escape") {
			e.preventDefault();
			handleDiscard();
		}
	};

	const inputClass =
		"w-full text-sm border rounded px-2 py-1 disabled:opacity-50";

	return (
		<div className="border rounded-lg p-4 mt-4 space-y-3" onKeyDown={onKeyDown}>
			{error && (
				<div className="p-2 rounded border border-destructive/50 bg-destructive/5 text-sm text-destructive">
					{error}
				</div>
			)}
			<label className="block text-xs font-medium">
				To
				<input
					type="text"
					className={inputClass}
					value={to}
					disabled={busy !== null}
					onChange={(e) => setTo(e.target.value)}
				/>
			</label>
			{defaults.cc !== undefined && (
				<label className="block text-xs font-medium">
					Cc
					<input
						type="text"
						className={inputClass}
						value={cc}
						disabled={busy !== null}
						onChange={(e) => setCc(e.target.value)}
					/>
				</label>
			)}
			<label className="block text-xs font-medium">
				Subject
				<input
					type="text"
					className={inputClass}
					value={subject}
					disabled={busy !== null}
					onChange={(e) => setSubject(e.target.value)}
				/>
			</label>
			{editor && <ComposeToolbar editor={editor} />}
			<TipTapEditor initialContent={defaults.quoteHtml} onReady={handleEditorReady} />
			<div className="flex gap-2 pt-2">
				<button
					type="button"
					className="text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={busy !== null || !editor}
					onClick={() => void handleSend()}
				>
					{busy === "send" ? "Sending…" : "Send"}
				</button>
				<button
					type="button"
					className="text-sm px-4 py-1.5 rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={busy !== null || !editor}
					onClick={() => void handleSaveDraft()}
				>
					{busy === "save" ? "Saving…" : "Save draft"}
				</button>
				<button
					type="button"
					className="text-sm px-4 py-1.5 rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
					onClick={handleDiscard}
				>
					{busy !== null ? "Cancel" : "Discard"}
				</button>
			</div>
		</div>
	);
}
