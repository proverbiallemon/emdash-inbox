import * as React from "react";
import type { Editor } from "@tiptap/react";

export function ComposeToolbar({ editor }: { editor: Editor }) {
 const [, render] = React.useReducer(n => n + 1, 0);
 React.useEffect(() => {
  const update = () => render();
  editor.on?.("transaction", update);
  return () => { editor.off?.("transaction", update); };
 }, [editor]);
 const handleLink = () => {
  const url = window.prompt("URL", editor.getAttributes("link").href ?? "");
  if (url === null) return;
  if (url === "") { editor.chain().focus().extendMarkRange("link").unsetLink().run(); return; }
  editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
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
 </div>;
}
