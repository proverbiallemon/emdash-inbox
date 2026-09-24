import * as React from "react";
import type { Editor } from "@tiptap/react";
import type { PublicAttachment } from "../lib/attachments";
import { postInbox, uploadDraftFiles } from "../lib/attachmentClient";
import { useComposeOperation } from "../lib/useComposeOperation";
import { useDeliveryAttempt, type SendResult } from "../lib/useDeliveryAttempt";
import { DeliveryNotice } from "./DeliveryNotice";
import { TipTapEditor } from "./TipTapEditor";
import { ComposeToolbar } from "./ComposeToolbar";
import { DraftAttachments } from "./DraftAttachments";
import { useLeaveGuard } from "../daylight/navigation";
import { useConfirmation, leaveConfirmation } from "../daylight/useConfirmation";
import { useEditorRevision } from "../daylight/useEditorRevision";
import { useComposeSignature } from "../lib/useComposeSignature";
import { SignatureLoading } from "./SignatureLoading";

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
	onSaved?: () => void;
}
interface ReplySnapshot { to: string; cc: string; subject: string; html: string }

export function ReplyCompose({ defaults, inReplyTo, threadId, onSent, onDiscard, onSaved }: Props) {
	const [to, setTo] = React.useState(defaults.to);
	const [cc, setCc] = React.useState(defaults.cc ?? "");
	const [subject, setSubject] = React.useState(defaults.subject);
	const [editor, setEditor] = React.useState<Editor | null>(null);
	const signature = useComposeSignature("replies", defaults.quoteHtml);
	const [savedSnapshot, setSavedSnapshot] = React.useState<ReplySnapshot | null>(null);
	const [attachments, setAttachments] = React.useState<PublicAttachment[]>([]);
	const currentDraft = React.useRef<string | null>(null);
	const { busy, error, setError, run, locked } = useComposeOperation();
	const delivery = useDeliveryAttempt();
	const confirmation = useConfirmation();
	useEditorRevision(editor);
	const disabled = busy !== null || delivery.status !== null || signature.html === null;

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
		if (delivery.isBlocked()) throw new Error("Resolve the delivery in Outbox before editing this reply.");
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
	const handleResult = (result: SendResult | undefined) => {
		if (!result || result.deliveryStatus === "pending" || result.deliveryStatus === "uncertain") return;
		if (result.deliveryStatus === "failed") {
			if (result.draftId) currentDraft.current = result.draftId;
			setError(result.error ?? "Delivery was rejected. Your reply remains editable as a draft.");
			return;
		}
		onSent();
	};
	const handleSend = async () => {
		if (!editor || delivery.isBlocked()) return;
		await run("send", async () => {
			const fields = { to, cc, subject, text: editor.getText(), html: editor.getHTML() };
			handleResult(currentDraft.current
				? await delivery.send("messages/draft-send", { draftId: currentDraft.current, edits: fields })
				: await delivery.send("messages/reply", { inReplyTo, ...fields }));
		});
	};
	const handleSaveDraft = () => run("save", async () => {
		await persistCurrentDraft();
		onSaved?.();
		onDiscard(); // The saved reply, including its files, remains in Drafts.
	});
	const handleUpload = (files: File[]) => run("upload", () => uploadDraftFiles(files, {
		existing: attachments, ensureDraft: persistCurrentDraft,
		onUploaded: (file) => setAttachments((current) => [...current, file]),
	}));
	const handleRemove = (attachmentId: string) => run("remove", async () => {
		if (delivery.isBlocked()) return;
		await postInbox("attachments/remove", { draftId: currentDraft.current, attachmentId });
		setAttachments((current) => current.filter((file) => file.id !== attachmentId));
	});
	const canLeave = async () => {
		if (locked.current || confirmation.pending.current) return false;
		if (delivery.isBlocked() || !isDirty()) return true;
		return await confirmation.confirm(leaveConfirmation) && !locked.current;
	};
	useLeaveGuard({ canLeave, canReplace: async () => !delivery.isBlocked() && await canLeave() && !delivery.isBlocked(), hasUnsaved: () => locked.current || (!delivery.isBlocked() && isDirty()) });
	const handleClose = async () => { if (await canLeave()) onDiscard(); };
	const handleDiscard = async () => {
		if (locked.current || delivery.isBlocked()) return;
		if ((isDirty() || currentDraft.current) && !await confirmation.confirm({ title: "Discard this reply?", description: "This removes the reply and any saved draft attachments. The conversation will stay in your mailbox.", action: "Discard reply" })) return;
		if (locked.current || delivery.isBlocked()) return;
		await run("discard", async () => {
			if (currentDraft.current) await postInbox("messages/draft-discard", { draftId: currentDraft.current });
			onDiscard();
		});
	};
	const onKeyDown = (event: React.KeyboardEvent) => {
		if ((event.target as HTMLElement).closest("dialog")) return;
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void handleSend(); }
		else if (event.key === "Escape") { event.preventDefault(); handleClose(); }
	};
	const inputClass = "w-full text-sm border rounded px-2 py-1 disabled:opacity-50";
	const buttonClass = "text-sm px-4 py-1.5 rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed";

	return <div className="dl-composer dl-reply-composer" onKeyDown={onKeyDown}>
		{confirmation.dialog}
		<div className="dl-compose-status"><strong>{defaults.cc !== undefined ? "Reply all" : "Reply"}</strong><span role="status">{busy === "save" ? "Saving draft…" : isDirty() ? "Unsaved changes" : currentDraft.current ? "Draft saved" : "Write your reply"}</span></div>
		{error && <div role="alert" className="p-2 rounded border border-destructive/50 bg-destructive/5 text-sm text-destructive">{error}</div>}
		<DeliveryNotice status={delivery.status} attemptId={delivery.attemptId} busy={busy !== null} onCheck={() => void run("send", async () => { handleResult(await delivery.check()); })} />
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
		<SignatureLoading state={signature} />
		{signature.html !== null && <TipTapEditor initialContent={signature.html} onReady={handleEditorReady} />}
		<DraftAttachments attachments={attachments} disabled={disabled || !editor} uploading={busy === "upload"} onUpload={(files) => void handleUpload(files)} onRemove={(id) => void handleRemove(id)} />
		<div className="dl-compose-actions">
			<button type="button" className="text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed" disabled={disabled || !editor} onClick={() => void handleSend()}>{busy === "send" ? "Sending…" : "Send"}</button>
			<button type="button" className={buttonClass} disabled={disabled || !editor} onClick={() => void handleSaveDraft()}>{busy === "save" ? "Saving…" : "Save draft"}</button>
			<button type="button" className={buttonClass} disabled={disabled} onClick={() => void handleDiscard()}>Discard</button>
			<button type="button" className={`${buttonClass} ml-auto`} disabled={busy !== null} onClick={handleClose}>Close</button>
		</div>
	</div>;
}
