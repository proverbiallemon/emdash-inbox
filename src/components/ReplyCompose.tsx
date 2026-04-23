import * as React from "react";
import type { Editor } from "@tiptap/react";
import { apiFetch } from "emdash/plugin-utils";
import { TipTapEditor } from "./TipTapEditor";
import { ComposeToolbar } from "./ComposeToolbar";

const API = "/_emdash/api/plugins/emdash-inbox";

export interface ReplyComposeDefaults {
	to: string;
	subject: string;
	quoteHtml: string;
}

interface Props {
	defaults: ReplyComposeDefaults;
	inReplyTo: string;
	onSent: () => void;
	onDiscard: () => void;
}

export function ReplyCompose({ defaults, inReplyTo, onSent, onDiscard }: Props) {
	const [to, setTo] = React.useState(defaults.to);
	const [subject, setSubject] = React.useState(defaults.subject);
	const [sending, setSending] = React.useState(false);
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
		if (!editor || sending) return;
		setSending(true);
		setError(null);
		const ctrl = new AbortController();
		setAbortCtrl(ctrl);
		try {
			const html = editor.getHTML();
			const text = editor.getText();
			const res = await apiFetch(`${API}/messages/reply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ inReplyTo, to, subject, text, html }),
				signal: ctrl.signal,
			});
			if (!res.ok) {
				let message = `send failed (${res.status})`;
				try {
					const body = (await res.json()) as { error?: { message?: string } };
					if (body?.error?.message) message = body.error.message;
				} catch {
					// non-JSON body — keep the status-code message
				}
				throw new Error(message);
			}
			onSent();
		} catch (err) {
			// AbortError fires when the user clicks Discard mid-send. Treat as
			// a no-op — the discard handler already calls onDiscard() to close
			// the form, and there's nothing for the user to retry.
			if (err instanceof DOMException && err.name === "AbortError") return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
			setAbortCtrl(null);
		}
	}, [editor, sending, inReplyTo, to, subject, onSent]);

	const handleDiscard = React.useCallback(() => {
		// Mid-send: cancel the in-flight request and close immediately. The user
		// explicitly chose to abandon the send, so don't confirm — they're already
		// committing to discard by clicking during "Sending…".
		if (sending) {
			abortCtrl?.abort();
			onDiscard();
			return;
		}
		if (isDirty() && !window.confirm("Discard this reply?")) return;
		onDiscard();
	}, [sending, abortCtrl, isDirty, onDiscard]);

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
					disabled={sending}
					onChange={(e) => setTo(e.target.value)}
				/>
			</label>
			<label className="block text-xs font-medium">
				Subject
				<input
					type="text"
					className={inputClass}
					value={subject}
					disabled={sending}
					onChange={(e) => setSubject(e.target.value)}
				/>
			</label>
			{editor && <ComposeToolbar editor={editor} />}
			<TipTapEditor initialContent={defaults.quoteHtml} onReady={handleEditorReady} />
			<div className="flex gap-2 pt-2">
				<button
					type="button"
					className="text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={sending || !editor}
					onClick={() => void handleSend()}
				>
					{sending ? "Sending…" : "Send"}
				</button>
				<button
					type="button"
					className="text-sm px-4 py-1.5 rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
					onClick={handleDiscard}
				>
					{sending ? "Cancel send" : "Discard"}
				</button>
			</div>
		</div>
	);
}
