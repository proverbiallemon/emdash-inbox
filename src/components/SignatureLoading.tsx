import * as React from "react";
import type { useComposeSignature } from "../lib/useComposeSignature";

export function SignatureLoading({ state }: { state: ReturnType<typeof useComposeSignature> }) {
	if (state.html !== null) return null;
	return <div className="dl-signature-loading">
		{state.error ? <>
			<p role="alert">Your signature could not be loaded. {state.error}</p>
			<button type="button" className="dl-button dl-subtle" onClick={state.retry}>Retry signature</button>
		</> : <p className="dl-muted" role="status">Loading your signature…</p>}
		<button type="button" className="dl-button dl-subtle" onClick={state.skip}>Continue without signature</button>
	</div>;
}
