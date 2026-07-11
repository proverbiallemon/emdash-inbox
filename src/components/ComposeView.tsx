import * as React from "react";
import type { Editor } from "@tiptap/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import { TipTapEditor } from "./TipTapEditor";
import { ComposeToolbar } from "./ComposeToolbar";

const API = "/_emdash/api/plugins/emdash-inbox";

interface DraftPayload {
	id: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	bodyHtml: string | null;
	bodyText: string;
	threadId: string | null;
}

interface Props {
	/** null = fresh compose; string = resume this draft. */
	draftId: string | null;
	onClose: () => void;
}

export function ComposeView({ draftId, onClose }: Props) {
	const [to, setTo] = React.useState("");
	const [cc, setCc] = React.useState("");
	const [bcc, setBcc] = React.useState("");
	const [showCcBcc, setShowCcBcc] = React.useState(false);
	const [subject, setSubject] = React.useState("");
	const [currentDraftId, setCurrentDraftId] = React.useState<string | null>(draftId);
	const [initialHtml, setInitialHtml] = React.useState<string | null>(draftId ? null : "");
	const [editor, setEditor] = React.useState<Editor | null>(null);
	const [busy, setBusy] = React.useState<"send" | "save" | null>(null);
	const [error, setError] = React.useState<string | null>(null);

	// Resume: load the draft's fields before mounting the editor.
	React.useEffect(() => {
		if (!draftId) return;
		let cancelled = false;
		(async () => {
			try {
				const res = await apiFetch(`${API}/messages/drafts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
				const data = await parseApiResponse<{ items: DraftPayload[] }>(res, "Failed to load draft");
				const draft = data.items.find((d) => d.id === draftId);
				if (!draft) throw new Error("Draft not found — it may have been sent or discarded.");
				if (cancelled) return;
				setTo(draft.to.join(", "));
				setCc(draft.cc.join(", "));
				setBcc(draft.bcc.join(", "));
				setShowCcBcc(draft.cc.length > 0 || draft.bcc.length > 0);
				setSubject(draft.subject === "(no subject)" ? "" : draft.subject);
				setInitialHtml(draft.bodyHtml ?? `<p>${draft.bodyText}</p>`);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => { cancelled = true; };
	}, [draftId]);

	const handleEditorReady = React.useCallback((ed: Editor) => {
		setEditor(ed);
		ed.commands.focus("start");
	}, []);

	const post = async (path: string, body: unknown) => {
		const res = await apiFetch(`${API}/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			let message = `request failed (${res.status})`;
			try {
				const parsed = (await res.json()) as { error?: { message?: string } };
				if (parsed?.error?.message) message = parsed.error.message;
			} catch { /* keep status message */ }
			throw new Error(message);
		}
		return res;
	};

	const handleSend = async () => {
		if (!editor || busy) return;
		setBusy("send");
		setError(null);
		try {
			const fields = { to, cc, bcc, subject, text: editor.getText(), html: editor.getHTML() };
			if (currentDraftId) {
				await post("messages/draft-send", { draftId: currentDraftId, edits: fields });
			} else {
				await post("messages/compose", fields);
			}
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const handleSaveDraft = async () => {
		if (!editor || busy) return;
		setBusy("save");
		setError(null);
		try {
			const res = await post("messages/draft-save", {
				draftId: currentDraftId ?? undefined,
				to, cc, bcc, subject,
				text: editor.getText(),
				html: editor.getHTML(),
			});
			const data = (await res.json()) as { data: { draftId: string } };
			setCurrentDraftId(data.data.draftId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const handleDiscard = async () => {
		// Guard against the "← Inbox" link and the Escape shortcut, neither of
		// which is disabled while busy the way the Discard button is — without
		// this, closing mid-send/mid-save unmounts the view while the request
		// is still in flight.
		if (busy) return;
		const dirty = editor && editor.getText().trim() !== "";
		if ((dirty || to || subject) && !window.confirm("Discard this email?")) return;
		if (currentDraftId) {
			try {
				await post("messages/draft-discard", { draftId: currentDraftId });
			} catch { /* draft may already be gone; closing is still right */ }
		}
		onClose();
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			void handleSend();
		} else if (e.key === "Escape") {
			e.preventDefault();
			void handleDiscard();
		}
	};

	const inputClass = "w-full text-sm border rounded px-2 py-1 disabled:opacity-50";
	const disabled = busy !== null;

	return (
		<div className="space-y-4" onKeyDown={onKeyDown}>
			<button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => void handleDiscard()}>
				← Inbox
			</button>
			<h1 className="text-3xl font-bold">{draftId ? "Edit draft" : "New email"}</h1>
			{error && (
				<div className="p-2 rounded border border-destructive/50 bg-destructive/5 text-sm text-destructive">{error}</div>
			)}
			<label className="block text-xs font-medium">
				To
				<input type="text" className={inputClass} value={to} disabled={disabled} placeholder="a@example.com, b@example.com" onChange={(e) => setTo(e.target.value)} />
			</label>
			{showCcBcc ? (
				<>
					<label className="block text-xs font-medium">
						Cc
						<input type="text" className={inputClass} value={cc} disabled={disabled} onChange={(e) => setCc(e.target.value)} />
					</label>
					<label className="block text-xs font-medium">
						Bcc
						<input type="text" className={inputClass} value={bcc} disabled={disabled} onChange={(e) => setBcc(e.target.value)} />
					</label>
				</>
			) : (
				<button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowCcBcc(true)}>
					Cc/Bcc
				</button>
			)}
			<label className="block text-xs font-medium">
				Subject
				<input type="text" className={inputClass} value={subject} disabled={disabled} onChange={(e) => setSubject(e.target.value)} />
			</label>
			{editor && <ComposeToolbar editor={editor} />}
			{initialHtml !== null && <TipTapEditor initialContent={initialHtml} onReady={handleEditorReady} />}
			<div className="flex gap-2 pt-2">
				<button type="button" className="text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed" disabled={disabled || !editor} onClick={() => void handleSend()}>
					{busy === "send" ? "Sending…" : "Send"}
				</button>
				<button type="button" className="text-sm px-4 py-1.5 rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed" disabled={disabled || !editor} onClick={() => void handleSaveDraft()}>
					{busy === "save" ? "Saving…" : currentDraftId ? "Save draft" : "Save as draft"}
				</button>
				<button type="button" className="text-sm px-4 py-1.5 rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed" disabled={disabled} onClick={() => void handleDiscard()}>
					Discard
				</button>
			</div>
		</div>
	);
}
