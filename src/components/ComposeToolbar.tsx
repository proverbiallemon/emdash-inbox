import * as React from "react";
import type { Editor } from "@tiptap/react";

interface Props {
	editor: Editor;
}

export function ComposeToolbar({ editor }: Props) {
	const btn =
		"text-xs px-2 py-1 border rounded hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed";
	const active = "bg-muted";

	const cls = (isActive: boolean) => `${btn} ${isActive ? active : ""}`.trim();

	const handleLink = () => {
		const previous = editor.getAttributes("link").href ?? "";
		const url = window.prompt("URL", previous);
		if (url === null) return;
		if (url === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}
		editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
	};

	return (
		<div className="flex flex-wrap gap-1 py-2 border-b">
			<button
				type="button"
				className={cls(editor.isActive("bold"))}
				onClick={() => editor.chain().focus().toggleBold().run()}
			>
				B
			</button>
			<button
				type="button"
				className={cls(editor.isActive("italic"))}
				onClick={() => editor.chain().focus().toggleItalic().run()}
			>
				I
			</button>
			<button
				type="button"
				className={cls(editor.isActive("bulletList"))}
				onClick={() => editor.chain().focus().toggleBulletList().run()}
			>
				• List
			</button>
			<button
				type="button"
				className={cls(editor.isActive("orderedList"))}
				onClick={() => editor.chain().focus().toggleOrderedList().run()}
			>
				1. List
			</button>
			<button
				type="button"
				className={cls(editor.isActive("blockquote"))}
				onClick={() => editor.chain().focus().toggleBlockquote().run()}
			>
				❝ Quote
			</button>
			<button type="button" className={btn} onClick={handleLink}>
				🔗 Link
			</button>
			<button
				type="button"
				className={btn}
				disabled={!editor.can().undo()}
				onClick={() => editor.chain().focus().undo().run()}
			>
				↶ Undo
			</button>
			<button
				type="button"
				className={btn}
				disabled={!editor.can().redo()}
				onClick={() => editor.chain().focus().redo().run()}
			>
				↷ Redo
			</button>
		</div>
	);
}
