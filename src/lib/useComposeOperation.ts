import * as React from "react";

export type ComposeOperation = "send" | "save" | "discard" | "upload" | "remove";

/** A ref closes the same-tick gap before React publishes the busy state. */
export function useComposeOperation() {
	const locked = React.useRef(false);
	const [busy, setBusy] = React.useState<ComposeOperation | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const run = React.useCallback(async (operation: ComposeOperation, work: () => Promise<void>) => {
		if (locked.current) return;
		locked.current = true; setBusy(operation); setError(null);
		try { await work(); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { locked.current = false; setBusy(null); }
	}, []);
	return { busy, error, setError, run, locked };
}
