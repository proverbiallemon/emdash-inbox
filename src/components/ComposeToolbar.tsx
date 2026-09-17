import * as React from "react";
import type { Editor } from "@tiptap/react";
import { Dialog } from "../daylight/Dialog";

export function ComposeToolbar({ editor }: { editor: Editor }) {
 const [linkUrl, setLinkUrl] = React.useState<string | null>(null);
 const [linkError, setLinkError] = React.useState("");
 const linkInput = React.useRef<HTMLInputElement>(null);
 const [, render] = React.useReducer(n => n + 1, 0);
 React.useEffect(() => {
  const update = () => render();
  editor.on?.("transaction", update);
  return () => { editor.off?.("transaction", update); };
 }, [editor]);
 const handleLink = () => {
  setLinkError("");setLinkUrl(editor.getAttributes("link").href ?? "");
 };
 const saveLink = () => {
  const url = linkUrl?.trim() ?? "";
  if (!/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(url) || /^\/\//.test(url)) { setLinkError("Enter a web address starting with https://, an email link, or a relative path.");return; }
  editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  setLinkUrl(null);
 };
 return <div className="dl-formatting" role="group" aria-label="Text formatting">
  <button type="button" aria-label="Bold" aria-pressed={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><strong>B</strong></button>
  <button type="button" aria-label="Italic" aria-pressed={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><em>I</em></button>
  <button type="button" aria-pressed={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
  <button type="button" aria-pressed={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. List</button>
  <button type="button" aria-pressed={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>Quote</button>
  <button type="button" aria-pressed={editor.isActive("link")} onClick={handleLink}>Link</button>
  <button type="button" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>↶ Undo</button>
  <button type="button" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>↷ Redo</button>
  {linkUrl !== null && <Dialog title="Add a link" initialFocus={linkInput} onClose={() => setLinkUrl(null)}>
   <form className="dl-link-form" onSubmit={event => { event.preventDefault();saveLink(); }}>
    <label>Link address<input ref={linkInput} type="text" inputMode="url" autoComplete="url" placeholder="https://example.com" value={linkUrl} onChange={event => {setLinkUrl(event.target.value);setLinkError("");}} /></label>
    {linkError && <p role="alert">{linkError}</p>}
    <div className="dl-confirm-actions">
     {editor.isActive("link") && <button type="button" className="dl-button" onClick={() => {editor.chain().focus().extendMarkRange("link").unsetLink().run();setLinkUrl(null);}}>Remove link</button>}
     <button type="button" className="dl-button" onClick={() => setLinkUrl(null)}>Cancel</button>
     <button type="submit" className="dl-button dl-primary">Save link</button>
    </div>
   </form>
  </Dialog>}
 </div>;
}
