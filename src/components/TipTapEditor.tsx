import * as React from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextStyleKit } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";
import Image from "@tiptap/extension-image";
import { sanitizeComposeHtml } from "../lib/sanitize";
import { decodeSignatureImage } from "../lib/signatureImage";

const InlineImage = Image.extend({
	addInputRules() { return []; },
	parseHTML() { return [{ tag: "img[src]", getAttrs: element => {
		try { return decodeSignatureImage((element as HTMLElement).getAttribute("src") ?? "") ? {} : false; } catch { return false; }
	} }]; },
}).configure({ allowBase64: true, inline: true });

interface Props {
	initialContent: string;
	onReady: (editor: Editor) => void;
	label?: string;
}

export function TipTapEditor({ initialContent, onReady, label = "Message body" }: Props) {
	const ready = React.useRef(onReady);
	ready.current = onReady;
	const editor = useEditor({
		// Keep untouched quoted replies stable; an implicit trailing paragraph
		// otherwise changes the saved snapshot on the first focus transaction.
		extensions: [StarterKit.configure({ trailingNode: false, link: { openOnClick: false, defaultProtocol: "https" } }), TextStyleKit.configure({ lineHeight: false }), TextAlign.configure({ types: ["paragraph", "heading"], defaultAlignment: null }), InlineImage],
		content: sanitizeComposeHtml(initialContent),
		editorProps: { attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true" }, transformPastedHTML: sanitizeComposeHtml },
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
