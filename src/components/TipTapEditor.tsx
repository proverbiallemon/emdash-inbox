import * as React from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

interface Props {
	initialContent: string;
	onReady: (editor: Editor) => void;
}

export function TipTapEditor({ initialContent, onReady }: Props) {
	const editor = useEditor({
		extensions: [StarterKit],
		content: initialContent,
	});

	// Notify parent once on mount; useEditor returns the same instance for the
	// component's lifetime, so a guard is not needed.
	React.useEffect(() => {
		if (editor) onReady(editor);
	}, [editor, onReady]);

	return (
		<EditorContent
			editor={editor}
			className="prose prose-sm max-w-none min-h-[12rem] border rounded p-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2"
		/>
	);
}
