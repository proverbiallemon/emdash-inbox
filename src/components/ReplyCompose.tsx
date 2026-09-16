import * as React from "react";
import type { Editor } from "@tiptap/react";
import type { PublicAttachment } from "../lib/attachments";
import { postInbox, uploadDraftFiles } from "../lib/attachmentClient";
import { useComposeOperation } from "../lib/useComposeOperation";
import { TipTapEditor } from "./TipTapEditor";
import { ComposeToolbar } from "./ComposeToolbar";
import { DraftAttachments } from "./DraftAttachments";

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
interface ReplySnapshot { to: string; cc: string; subject: string; html: string }

export function ReplyCompose({ defaults, inReplyTo, threadId, onSent, onDiscard }: Props) {
	const [to, setTo] = React.useState(defaults.to);
	const [cc, setCc] = React.useState(defaults.cc ?? "");
	const [subject, setSubject] = React.useState(defaults.subject);
	const [editor, setEditor] = React.useState<Editor | null>(null);
	const [savedSnapshot, setSavedSnapshot] = React.useState<ReplySnapshot | null>(null);
	const [attachments, setAttachments] = React.useState<PublicAttachment[]>([]);
	const currentDraft = React.useRef<string | null>(null);
	const { busy, error, run, locked } = useComposeOperation();
	const disabled = busy !== null;

	const handleEditorReady = React.useCallback((ed: Editor) => {
		setEditor(ed);
		setSavedSnapshot({ to: defaults.to, cc: defaults.cc ?? "", subject: defaults.subject, html: ed.getHTML() });
		ed.commands.focus("start");
	}, [defaults.to, defaults.cc, defaults.subject]);
	React.useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);

	const isDirty = () => {
		if (!editor || !savedSnapshot) return false;
		return to !== savedSnapshot.to || cc !== savedSnapshot.cc || subject !== savedSnapshot.subject || editor.getHTML() !== savedSnapshot.html;
	};
	const persistCurrentDraft = async (): Promise<string> => {
		if (!editor) throw new Error("The editor is still loading.");
		const html = editor.getHTML();
		const result = await postInbox<{ draftId: string }>("messages/draft-save", {
			draftId: currentDraft.current ?? undefined, threadId: threadId ?? inReplyTo,
			to, cc, subject, text: editor.getText(), html,
		});
		currentDraft.current = result.draftId;
		setSavedSnapshot({ to, cc, subject, html });
		return result.draftId;
	};
	const handleSend = async () => {
		if (!editor) return;
		await run("send", async () => {
			const fields = { to, cc, subject, text: editor.getText(), html: editor.getHTML() };
			if (currentDraft.current) await postInbox("messages/draft-send", { draftId: currentDraft.current, edits: fields });
			else await postInbox("messages/reply", { inReplyTo, ...fields });
			onSent();
		});
	};
	const handleSaveDraft = () => run("save", async () => {
		await persistCurrentDraft();
		onDiscard(); // The saved reply, including its files, remains in Drafts.
	});
	const handleUpload = (files: File[]) => run("upload", () => uploadDraftFiles(files, {
		existing: attachments, ensureDraft: persistCurrentDraft,
		onUploaded: (file) => setAttachments((current) => [...current, file]),
	}));
	const handleRemove = (attachmentId: string) => run("remove", async () => {
		await postInbox("attachments/remove", { draftId: currentDraft.current, attachmentId });
		setAttachments((current) => current.filter((file) => file.id !== attachmentId));
	});
	const handleClose = () => {
		if (locked.current) return;
		if (isDirty() && !window.confirm("Close without saving your changes?")) return;
		onDiscard();
	};
	const handleDiscard = async () => {
		if (locked.current) return;
		if ((isDirty() || currentDraft.current) && !window.confirm("Discard this reply?")) return;
		await run("discard", async () => {
			if (currentDraft.current) await postInbox("messages/draft-discard", { draftId: currentDraft.current });
			onDiscard();
		});
	};
	const onKeyDown = (event: React.KeyboardEvent) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void handleSend(); }
		else if (event.key === "Escape") { event.preventDefault(); handleClose(); }
	};
	const inputClass = "w-full text-sm border rounded px-2 py-1 disabled:opacity-50";
	const buttonClass = "text-sm px-4 py-1.5 rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed";

	return <div className="border rounded-lg p-4 mt-4 space-y-3" onKeyDown={onKeyDown}>
		{error && <div role="alert" className="p-2 rounded border border-destructive/50 bg-destructive/5 text-sm text-destructive">{error}</div>}
		<label className="block text-xs font-medium">To
			<input type="text" className={inputClass} value={to} disabled={disabled} onChange={(event) => setTo(event.target.value)} />
		</label>
		{defaults.cc !== undefined && <label className="block text-xs font-medium">Cc
			<input type="text" className={inputClass} value={cc} disabled={disabled} onChange={(event) => setCc(event.target.value)} />
		</label>}
		<label className="block text-xs font-medium">Subject
			<input type="text" className={inputClass} value={subject} disabled={disabled} onChange={(event) => setSubject(event.target.value)} />
		</label>
		{editor && <fieldset disabled={disabled}><ComposeToolbar editor={editor} /></fieldset>}
		<TipTapEditor initialContent={defaults.quoteHtml} onReady={handleEditorReady} />
		<DraftAttachments attachments={attachments} disabled={disabled || !editor} uploading={busy === "upload"} onUpload={(files) => void handleUpload(files)} onRemove={(id) => void handleRemove(id)} />
		<div className="flex flex-wrap gap-2 pt-2">
			<button type="button" className="text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed" disabled={disabled || !editor} onClick={() => void handleSend()}>{busy === "send" ? "Sending…" : "Send"}</button>
			<button type="button" className={buttonClass} disabled={disabled || !editor} onClick={() => void handleSaveDraft()}>{busy === "save" ? "Saving…" : "Save draft"}</button>
			<button type="button" className={buttonClass} disabled={disabled} onClick={() => void handleDiscard()}>Discard</button>
			<button type="button" className={`${buttonClass} ml-auto`} disabled={disabled} onClick={handleClose}>Close</button>
		</div>
	</div>;
}
