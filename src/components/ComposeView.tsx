import * as React from "react";
import type { Editor } from "@tiptap/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import { plainTextToHtml } from "../lib/replyDefaults";
import { TipTapEditor } from "./TipTapEditor";
import { ComposeToolbar } from "./ComposeToolbar";
import { DraftAttachments } from "./DraftAttachments";
import type { PublicAttachment } from "../lib/attachments";
import { postInbox, uploadDraftFiles } from "../lib/attachmentClient";
import { useComposeOperation } from "../lib/useComposeOperation";
import { useDeliveryAttempt, type SendResult } from "../lib/useDeliveryAttempt";
import { DeliveryNotice } from "./DeliveryNotice";
import { useLeaveGuard } from "../daylight/navigation";
import { useEditorRevision } from "../daylight/useEditorRevision";

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
	attachments?: PublicAttachment[];
}

interface Props {
	/** null = fresh compose; string = resume this draft. */
	draftId: string | null;
	onClose: () => void;
	onSent?: () => void;
}

interface ComposeSnapshot {
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	editorHTML: string;
}

export function ComposeView({ draftId, onClose, onSent }: Props) {
	const [to, setTo] = React.useState("");
	const [cc, setCc] = React.useState("");
	const [bcc, setBcc] = React.useState("");
	const [showCcBcc, setShowCcBcc] = React.useState(false);
	const [subject, setSubject] = React.useState("");
	const [currentDraftId, setCurrentDraftId] = React.useState<string | null>(draftId);
	const currentDraft = React.useRef<string | null>(draftId);
	const [attachments, setAttachments] = React.useState<PublicAttachment[]>([]);
	const [initialHtml, setInitialHtml] = React.useState<string | null>(draftId ? null : "");
	const [editor, setEditor] = React.useState<Editor | null>(null);
	const { busy, error, setError, run, locked } = useComposeOperation();
	const delivery = useDeliveryAttempt();
	useEditorRevision(editor);
	// Fields as of the last successful save; null until something has been
	// saved (fresh compose) or set from the loaded draft (resumed compose).
	// Used to decide whether closing needs a confirmation.
	const [savedSnapshot, setSavedSnapshot] = React.useState<ComposeSnapshot | null>(null);

	// Resume: load the draft's fields before mounting the editor.
	React.useEffect(() => {
		if (!draftId) return;
		let cancelled = false;
		(async () => {
			try {
				const res = await apiFetch(`${API}/messages/drafts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
				const data = await parseApiResponse<{ items: DraftPayload[] }>(res, "Failed to load draft");
				const draft = data.items.find((d) => d.id === draftId);
				if (!draft) throw new Error("Draft not found — it may be in Outbox, sent, or discarded. Check Outbox before sending again.");
				if (cancelled) return;
				setTo(draft.to.join(", "));
				setCc(draft.cc.join(", "));
				setBcc(draft.bcc.join(", "));
				setShowCcBcc(draft.cc.length > 0 || draft.bcc.length > 0);
				setAttachments(draft.attachments ?? []);
				const loadedSubject = draft.subject === "(no subject)" ? "" : draft.subject;
				const loadedHtml = draft.bodyHtml ?? plainTextToHtml(draft.bodyText);
				setSubject(loadedSubject);
				setInitialHtml(loadedHtml);
				setSavedSnapshot({
					to: draft.to.join(", "),
					cc: draft.cc.join(", "),
					bcc: draft.bcc.join(", "),
					subject: loadedSubject,
					editorHTML: loadedHtml,
				});
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => { cancelled = true; };
	}, [draftId]);

	const handleEditorReady = React.useCallback((ed: Editor) => {
		setEditor(ed);
		setSavedSnapshot(current => current ? { ...current, editorHTML: ed.getHTML() } : current);
		ed.commands.focus("start");
	}, []);

	React.useEffect(() => { editor?.setEditable(busy === null && !delivery.status); }, [editor, busy, delivery.status]);

	const handleResult = (result: SendResult | undefined) => {
		if (!result || result.deliveryStatus === "pending" || result.deliveryStatus === "uncertain") return;
		if (result.deliveryStatus === "failed") {
			if (result.draftId) { currentDraft.current = result.draftId; setCurrentDraftId(result.draftId); }
			setError(result.error ?? "Delivery was rejected. Your email remains editable as a draft.");
			return;
		}
		onSent?.();
		onClose();
	};

	const handleSend = async () => {
		if (!editor || delivery.isBlocked()) return;
		await run("send", async () => {
			const fields = { to, cc, bcc, subject, text: editor.getText(), html: editor.getHTML() };
			handleResult(currentDraft.current
				? await delivery.send("messages/draft-send", { draftId: currentDraft.current, edits: fields })
				: await delivery.send("messages/compose", fields));
		});
	};

	const persistCurrentDraft = async (): Promise<string> => {
		if (delivery.isBlocked()) throw new Error("Resolve the delivery in Outbox before editing this email.");
		if (!editor) throw new Error("The editor is still loading.");
		const html = editor.getHTML();
		const data = await postInbox<{ draftId: string }>("messages/draft-save", {
			draftId: currentDraft.current ?? undefined, to, cc, bcc, subject, text: editor.getText(), html,
		});
		currentDraft.current = data.draftId;
		setCurrentDraftId(data.draftId);
		setSavedSnapshot({ to, cc, bcc, subject, editorHTML: html });
		return data.draftId;
	};
	const handleSaveDraft = async () => { if (editor) await run("save", async () => { await persistCurrentDraft(); }); };
	const handleUpload = (files: File[]) => run("upload", () => uploadDraftFiles(files, {
		existing: attachments, ensureDraft: persistCurrentDraft,
		onUploaded: (file) => setAttachments((current) => [...current, file]),
	}));
	const handleRemove = (attachmentId: string) => run("remove", async () => {
		if (delivery.isBlocked()) return;
		await postInbox("attachments/remove", { draftId: currentDraft.current, attachmentId });
		setAttachments((current) => current.filter((file) => file.id !== attachmentId));
	});

	const hasAnyContent = () => {
		const dirty = editor ? editor.getText().trim() !== "" : false;
		return dirty || Boolean(to) || Boolean(cc) || Boolean(bcc) || Boolean(subject);
	};

	// "← Inbox" and Escape: never deletes a saved draft. Only asks for
	// confirmation when there's something that hasn't been saved yet.
	const isDirty = () => {
		if (!savedSnapshot) return hasAnyContent();
		const current = { to, cc, bcc, subject, editorHTML: editor?.getHTML() ?? "" };
		return (Object.keys(current) as (keyof ComposeSnapshot)[]).some(key => current[key] !== savedSnapshot[key]);
	};
	const canLeave = () => !locked.current && (delivery.isBlocked() || !isDirty() || window.confirm("Close without saving your changes?"));
	useLeaveGuard({ canLeave, hasUnsaved: () => locked.current || (!delivery.isBlocked() && isDirty()) });
	const handleClose = () => { if (canLeave()) onClose(); };

	// Discard button: deletes the persisted draft (if any) after confirming,
	// since this is the explicit "throw this away" action.
	const handleDiscard = async () => {
		if (locked.current || delivery.isBlocked() || (draftId !== null && initialHtml === null)) return;
		if ((hasAnyContent() || currentDraftId) && !window.confirm("Discard this email?")) return;
		await run("discard", async () => {
			if (currentDraft.current) await postInbox("messages/draft-discard", { draftId: currentDraft.current });
			onClose();
		});
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if ((e.target as HTMLElement).closest("dialog")) return;
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			void handleSend();
		} else if (e.key === "Escape") {
			e.preventDefault();
			handleClose();
		}
	};

	const inputClass = "w-full text-sm border rounded px-2 py-1 disabled:opacity-50";
	const disabled = busy !== null || delivery.status !== null || (draftId !== null && initialHtml === null);

	return (
		<div className="dl-composer" onKeyDown={onKeyDown}>
			<div className="dl-compose-heading">
			<h1>{draftId ? "Edit draft" : "New message"}</h1>
			<button type="button" disabled={busy !== null} className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={handleClose}>
				← Inbox
			</button>
			</div>
			<p className="dl-muted" role="status">{busy === "save" ? "Saving draft…" : isDirty() ? "Unsaved changes" : currentDraftId ? "Draft saved" : "A fresh message"}</p>
			{error && (
				<div role="alert" className="p-2 rounded border border-destructive/50 bg-destructive/5 text-sm text-destructive">{error}</div>
			)}
			{error && draftId && initialHtml === null && <a href="/_emdash/admin/plugins/emdash-inbox?status=outbox" className="inline-block text-sm underline">Open Outbox</a>}
			<DeliveryNotice status={delivery.status} attemptId={delivery.attemptId} busy={busy !== null} onCheck={() => void run("send", async () => { handleResult(await delivery.check()); })} />
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
				<button type="button" disabled={disabled} className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowCcBcc(true)}>
					Cc/Bcc
				</button>
			)}
			<label className="block text-xs font-medium">
				Subject
				<input type="text" className={inputClass} value={subject} disabled={disabled} onChange={(e) => setSubject(e.target.value)} />
			</label>
			{editor && <fieldset disabled={disabled}><ComposeToolbar editor={editor} /></fieldset>}
			{initialHtml !== null && <TipTapEditor initialContent={initialHtml} onReady={handleEditorReady} />}
			<DraftAttachments attachments={attachments} disabled={disabled || !editor} uploading={busy === "upload"} onUpload={(files) => void handleUpload(files)} onRemove={(id) => void handleRemove(id)} />
			<div className="dl-compose-actions">
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
