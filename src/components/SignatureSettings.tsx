import * as React from "react";
import type { Editor } from "@tiptap/react";
import { postInbox } from "../lib/attachmentClient";
import { getSignature } from "../lib/signatureClient";
import { defaultSignature, type EmailSignature } from "../lib/signature";
import { daylightStyles } from "../daylight/styles";
import { TipTapEditor } from "./TipTapEditor";
import { ComposeToolbar } from "./ComposeToolbar";
import { plainTextToHtml } from "../lib/replyDefaults";
import { sanitizeComposeHtml } from "../lib/sanitize";

export function SignatureSettings() {
	const [signature, setSignature] = React.useState<EmailSignature>({ ...defaultSignature });
	const [loading, setLoading] = React.useState(true);
	const [canSave, setCanSave] = React.useState(false);
	const [busy, setBusy] = React.useState(false);
	const [uploadingImage, setUploadingImage] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [saved, setSaved] = React.useState(false);
	const [attempt, retry] = React.useReducer(value => value + 1, 0);
	const [initialHtml, setInitialHtml] = React.useState("");
	const [editor, setEditor] = React.useState<Editor | null>(null);
	const id = React.useId();
	React.useEffect(() => {
		let cancelled = false;
		setLoading(true); setError(null);
		void getSignature().then(data => {
			if (cancelled) return;
			setSignature(data.signature); setCanSave(data.canSave); setLoading(false);
			setInitialHtml(data.signature.html ?? plainTextToHtml(data.signature.text));
		}).catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)); });
		return () => { cancelled = true; };
	}, [attempt]);
	React.useEffect(() => { editor?.setEditable(!busy && canSave, false); }, [editor, busy, canSave]);
	React.useEffect(() => {
		if (!editor) return;
		const changed = () => setSaved(false);
		editor.on("update", changed);
		return () => { editor.off("update", changed); };
	}, [editor]);
	const change = (patch: Partial<EmailSignature>) => { setSignature(current => ({ ...current, ...patch })); setSaved(false); };
	const save = async () => {
		if (busy || uploadingImage || loading || !canSave || !editor) return;
		setBusy(true); setError(null); setSaved(false);
		try {
			const result = await postInbox<{ signature: EmailSignature }>("signature/save", { ...signature, text: editor.getText().trim(), html: editor.isEmpty ? "" : sanitizeComposeHtml(editor.getHTML()) });
			editor.commands.setContent(result.signature.html ?? plainTextToHtml(result.signature.text), { emitUpdate: false });
			setSignature(result.signature); setSaved(true);
		} catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
		finally { setBusy(false); }
	};
	return <section className="dl-root dl-signature-settings" aria-labelledby={`${id}-title`}>
		<style>{daylightStyles}{`
.dl-root.dl-signature-settings{min-height:0;border:1px solid var(--dl-line);border-radius:20px;padding:24px;display:flex;flex-direction:column;gap:16px;margin:24px 0}
.dl-signature-settings .dl-editor .tiptap{min-height:160px}
.dl-signature-settings fieldset{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:8px}
.dl-signature-settings legend{font-weight:700;margin-bottom:8px}.dl-signature-settings .dl-signature-toggle{display:flex;gap:10px;align-items:center;min-height:44px}.dl-signature-settings input[type=checkbox]{width:20px;height:20px;accent-color:var(--dl-accent);flex-shrink:0}
.dl-signature-settings .dl-button{align-self:flex-start;min-height:44px;white-space:normal}.dl-signature-settings .dl-muted{font-size:12px}
`}</style>
		<div><p className="dl-eyebrow">MAKE IT YOURS</p><h2 id={`${id}-title`}>Email signature</h2></div>
		<p className="dl-muted" id={`${id}-help`}>Saved for your EmDash account. Added when you start a message, so you can edit it before sending. Existing drafts keep their original text.</p>
		{error && <p role="alert">{error}</p>}
		{loading ? error ? <button type="button" className="dl-button" onClick={retry}>Retry signature</button> : <p role="status">Loading signature…</p> : <>
			{!canSave && <p role="status">Sign in as a user to save a personal signature.</p>}
			{editor && <fieldset disabled={busy || !canSave}><ComposeToolbar editor={editor} allowImages onImageBusyChange={setUploadingImage} /></fieldset>}
			<TipTapEditor label="Email signature" initialContent={initialHtml} onReady={setEditor} />
			<p className="dl-muted">Select text to change its font, size or colors. Upload PNG, JPEG, GIF or WebP logos (64 KiB total); select an image to resize it. Fonts may vary by recipient. Clear the editor and save to remove your signature.</p>
			<fieldset disabled={busy || !canSave}><legend>Automatically include in</legend>
				<label className="dl-signature-toggle"><input type="checkbox" checked={signature.newMessages} onChange={event => change({ newMessages: event.target.checked })} />New messages</label>
				<label className="dl-signature-toggle"><input type="checkbox" checked={signature.replies} onChange={event => change({ replies: event.target.checked })} />Replies and reply all</label>
			</fieldset>
			{saved && <p className="dl-notice" role="status">Signature saved.</p>}
			<button type="button" className="dl-button dl-primary" disabled={busy || uploadingImage || !canSave || !editor} onClick={() => void save()}>{busy ? "Saving signature…" : "Save signature"}</button>
		</>}
	</section>;
}
