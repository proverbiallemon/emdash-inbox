import * as React from "react";
import type { Editor } from "@tiptap/react";
import { Dialog } from "../daylight/Dialog";
import { readSignatureImage, SIGNATURE_IMAGE_TYPES } from "../lib/signatureImage";

const fonts = ["Arial", "Verdana", "Trebuchet MS", "Georgia", "Times New Roman", "Courier New"];
function colorHex(value: string | undefined, fallback: string) {
 if (/^#[\da-f]{6}$/i.test(value ?? "")) return value!;
 const rgb = value?.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/);
 return rgb ? "#" + rgb.slice(1).map(n => Number(n).toString(16).padStart(2,"0")).join("") : fallback;
}

export function ComposeToolbar({ editor, allowImages = false, onImageBusyChange }: { editor: Editor; allowImages?: boolean; onImageBusyChange?: (busy: boolean) => void }) {
 const [linkUrl, setLinkUrl] = React.useState<string | null>(null);
 const [linkError, setLinkError] = React.useState("");
 const linkInput = React.useRef<HTMLInputElement>(null);
 const imageInput = React.useRef<HTMLInputElement>(null);
 const [imageError, setImageError] = React.useState("");
 const [uploading, setUploading] = React.useState(false);
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
 const uploadImage = async (file?: File) => {
  if (!file || uploading) return;
  setUploading(true); onImageBusyChange?.(true); setImageError("");
  try {
   const src = await readSignatureImage(file);
   if (!editor.isDestroyed) editor.chain().focus().setImage({ src, alt: file.name.replace(/\.[^.]+$/, ""), width: 160 }).run();
  } catch (error) { setImageError(error instanceof Error ? error.message : String(error)); }
  finally { setUploading(false); onImageBusyChange?.(false); if (imageInput.current) imageInput.current.value = ""; }
 };
 // Attribute changes replace the image node. Restore its node selection so
 // editing its description does not unmount the focused image controls.
 const updateImage = (attributes: Record<string, unknown>) => {
  const position = editor.state.selection.from;
  editor.chain().updateAttributes("image", attributes).setNodeSelection(position).run();
 };
 const textStyle = editor.getAttributes("textStyle");
 return <div className="dl-formatting" role="group" aria-label="Text formatting">
  <label className="dl-format-select">Font<select aria-label="Font family" value={fonts.find(font => String(textStyle.fontFamily ?? "").replace(/['"]/g, "").startsWith(font)) ?? ""} onChange={event => { const font = event.target.value; const chain = editor.chain().focus(); (font ? chain.setFontFamily(font) : chain.unsetFontFamily()).run(); }}><option value="">Default</option>{fonts.map(font => <option key={font} value={font}>{font}</option>)}</select></label>
  <label className="dl-format-select">Size<select aria-label="Font size" value={textStyle.fontSize ?? ""} onChange={event => {const size = event.target.value; const chain = editor.chain().focus(); (size ? chain.setFontSize(size) : chain.unsetFontSize()).run();}}><option value="">Default</option>{[10,12,14,16,18,24,32].map(size => <option key={size} value={`${size}px`}>{size}</option>)}</select></label>
  <label className="dl-format-color">Text color<input aria-label="Text color" type="color" value={colorHex(textStyle.color, "#1e2e4a")} onChange={event => editor.chain().focus().setColor(event.target.value).run()} /></label>
  <label className="dl-format-color">Highlight<input aria-label="Highlight color" type="color" value={colorHex(textStyle.backgroundColor, "#fff0e1")} onChange={event => editor.chain().focus().setBackgroundColor(event.target.value).run()} /></label>
  <button type="button" aria-label="Bold" aria-pressed={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><strong>B</strong></button>
  <button type="button" aria-label="Italic" aria-pressed={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><em>I</em></button>
  <button type="button" aria-label="Underline" aria-pressed={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></button>
  <button type="button" aria-label="Strikethrough" aria-pressed={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></button>
  <label className="dl-format-select">Align<select aria-label="Text alignment" value={editor.getAttributes("paragraph").textAlign ?? editor.getAttributes("heading").textAlign ?? "left"} onChange={event => editor.chain().focus().setTextAlign(event.target.value).run()}>{["left","center","right","justify"].map(align => <option key={align}>{align}</option>)}</select></label>
  <button type="button" aria-pressed={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
  <button type="button" aria-pressed={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. List</button>
  <button type="button" aria-pressed={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>Quote</button>
  <button type="button" aria-pressed={editor.isActive("link")} onClick={handleLink}>Link</button>
  <button type="button" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().unsetTextAlign().run()}>Clear formatting</button>
  {allowImages && <><button type="button" disabled={uploading} onClick={() => imageInput.current?.click()}>{uploading ? "Reading image…" : "Add image"}</button><input hidden ref={imageInput} type="file" aria-label="Upload signature image" accept={SIGNATURE_IMAGE_TYPES} disabled={uploading} onChange={event => void uploadImage(event.target.files?.[0])} /></>}
  {editor.isActive("image") && <div className="dl-image-controls"><label>Image description<input aria-label="Image description" value={editor.getAttributes("image").alt ?? ""} onChange={event => updateImage({ alt: event.target.value })} /></label><label>Image width<select aria-label="Image width" value={editor.getAttributes("image").width ?? 160} onChange={event => updateImage({ width: Number(event.target.value), height: null })}>{[64,100,160,240,320].map(width => <option key={width} value={width}>{width} px</option>)}</select></label><button type="button" onClick={() => editor.chain().focus().deleteSelection().run()}>Remove image</button></div>}
  {imageError && <p role="alert">{imageError}</p>}
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
