import * as React from "react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";

/** Browser DTO: never includes the private delivery snapshot. */
export interface SendResult {
	id: string | null;
	threadId: string | null;
	attemptId?: string;
	deliveryStatus?: "sent" | "pending" | "uncertain" | "failed";
	draftId?: string;
	error?: string;
}
export type DeliveryNoticeState = "pending" | "uncertain" | "unconfirmed";
interface OriginalRequest { path: string; body: string }

/** An unknown response can only recheck the immutable, original request. */
export function useDeliveryAttempt() {
	const request = React.useRef<OriginalRequest | null>(null);
	const statusRef = React.useRef<DeliveryNoticeState | null>(null);
	const [status, setStatus] = React.useState<DeliveryNoticeState | null>(null);
	const [attemptId, setAttemptId] = React.useState<string | undefined>();
	const updateStatus = (next: DeliveryNoticeState | null) => { statusRef.current = next; setStatus(next); };
	const perform = async (original: OriginalRequest): Promise<SendResult> => {
		let response: Response | undefined;
		let result: SendResult;
		try {
			response = await apiFetch(`/_emdash/api/plugins/emdash-inbox/${original.path}`, {
				method: "POST", headers: { "Content-Type": "application/json" }, body: original.body,
			});
			result = await parseApiResponse<SendResult>(response, "Send request failed");
			if (!result || typeof result !== "object"
				|| !(result.id === null || typeof result.id === "string")
				|| !(result.threadId === null || typeof result.threadId === "string")
				|| (result.deliveryStatus !== undefined && !["sent", "pending", "uncertain", "failed"].includes(result.deliveryStatus))) {
				throw new Error("The send response could not be read.");
			}
		} catch (error) {
			// A rejected recheck says nothing about the original request. Keep
			// its key and lock even if the session expired in the meantime.
			if (statusRef.current === "unconfirmed" || !response || response.ok || response.status >= 500 || response.status === 408) updateStatus("unconfirmed");
			else { request.current = null; updateStatus(null); }
			throw error;
		}
		setAttemptId(result.attemptId);
		if (result.deliveryStatus === "pending" || result.deliveryStatus === "uncertain") updateStatus(result.deliveryStatus);
		else { request.current = null; updateStatus(null); }
		return result;
	};
	return {
		status, attemptId,
		isBlocked: () => statusRef.current !== null,
		send: async (path: string, payload: Record<string, unknown>) => {
			if (statusRef.current) return;
			const original = { path, body: JSON.stringify({ ...payload, requestId: crypto.randomUUID() }) };
			request.current = original;
			return perform(original);
		},
		check: async () => {
			if (statusRef.current !== "unconfirmed" || !request.current) return;
			return perform(request.current);
		},
	};
}
