import type { DeliveryNoticeState } from "../lib/useDeliveryAttempt";

export function DeliveryNotice({ status, attemptId, busy, onCheck }: {
	status: DeliveryNoticeState | null;
	attemptId?: string;
	busy: boolean;
	onCheck: () => void;
}) {
	if (!status) return null;
	return <div role="status" className="rounded border bg-muted/40 p-3 text-sm space-y-2">
		<p>{status === "pending"
			? "Delivery is still being recorded. Check Outbox for the result before sending again."
			: status === "uncertain"
				? "Delivery outcome is uncertain. Verify with your email provider, then resolve it in Outbox before sending again."
				: "The send response was lost. This email may have been accepted. Editing and sending again are paused until the original request is checked."}</p>
		{attemptId && <p className="text-xs text-muted-foreground break-all">Attempt: {attemptId}</p>}
		{status === "unconfirmed" && <>
			<p className="text-xs text-muted-foreground">Checking repeats the original request safely. If it never reached the server, this may send it once.</p>
			<button type="button" className="rounded border px-3 py-1.5 disabled:opacity-50" disabled={busy} onClick={onCheck}>{busy ? "Checking…" : "Retry original request"}</button>
		</>}
		<a href="/_emdash/admin/plugins/emdash-inbox?status=outbox" className="inline-block underline ml-2">Open Outbox</a>
	</div>;
}
