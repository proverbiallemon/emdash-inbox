import * as React from "react";
import type { Editor } from "@tiptap/react";

/** Reflect editor changes in draft status without replacing the editor instance. */
export function useEditorRevision(editor: Editor | null) {
	const [, update] = React.useReducer(value => value + 1, 0);
	React.useEffect(() => {
		if (!editor) return;
		const changed = () => update();
		editor.on?.("update", changed);
		return () => { editor.off?.("update", changed); };
	}, [editor]);
}
