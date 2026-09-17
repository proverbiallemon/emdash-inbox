import * as React from "react";
import { postInbox } from "../lib/attachmentClient";
import type { InboxPreferences } from "../lib/uiPreferences";
const defaultInboxPreferences: InboxPreferences = { navigation: "top", fullWindow: false };

export function useInboxPreferences() {
	const [preferences, setPreferences] = React.useState(defaultInboxPreferences);
	const [name, setName] = React.useState<string | null>(null);
	const [senderAddress, setSenderAddress] = React.useState("");
	const [canSave, setCanSave] = React.useState(false);
	const [loading, setLoading] = React.useState(true);
	const [saving, setSaving] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const locked = React.useRef(false);
	React.useEffect(() => {
		let active = true;
		postInbox<{ preferences: InboxPreferences; name: string | null; canSave: boolean; senderAddress?: string }>("ui/preferences", {}).then(data => {
			if (!active || !data.preferences) return;
			setPreferences(data.preferences); setName(data.name); setCanSave(data.canSave);
			setSenderAddress(data.senderAddress ?? "");
		}).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Could not load your layout."); })
			.finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, []);
	const update = async (next: InboxPreferences) => {
		if (locked.current || loading) return;
		locked.current = true; setSaving(true); setError(null);
		try {
			if (canSave) await postInbox("ui/preferences-save", next);
			setPreferences(next);
		} catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save your layout. Try again."); }
		finally { locked.current = false; setSaving(false); }
	};
	return { preferences, name, senderAddress, canSave, loading, saving, error, update };
}
