import * as React from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

interface Props {
	initialContent: string;
	onReady: (editor: Editor) => void;
}

export function TipTapEditor({ initialContent, onReady }: Props) {
	const ready = React.useRef(onReady);
	ready.current = onReady;
	const editor = useEditor({
		// Keep untouched quoted replies stable; an implicit trailing paragraph
		// otherwise changes the saved snapshot on the first focus transaction.
		extensions: [StarterKit.configure({ trailingNode: false })],
		content: initialContent,
		editorProps: { attributes: { role: "textbox", "aria-label": "Message body", "aria-multiline": "true" } },
	});

	// A refreshed thread may change defaults without replacing this editor.
	// Notify only for a new editor so that refreshes cannot reset dirty state.
	React.useEffect(() => {
		if (editor) ready.current(editor);
	}, [editor]);

	return (
		<EditorContent
			editor={editor}
			className="dl-editor"
		/>
	);
}
