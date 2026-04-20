export type MessageStatus = "inbox" | "snoozed" | "done" | "archived";
export type RequestedStatus = "inbox" | "snoozed" | "done";

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateTransition(
	_current: MessageStatus,
	requested: RequestedStatus,
	snoozeUntil?: string,
): ValidationResult {
	if (requested === "snoozed") {
		if (!snoozeUntil) {
			return { ok: false, error: "snoozeUntil required when requested=snoozed" };
		}
		const t = Date.parse(snoozeUntil);
		if (Number.isNaN(t)) {
			return { ok: false, error: "snoozeUntil must be a valid ISO8601 timestamp" };
		}
		if (t <= Date.now()) {
			return { ok: false, error: "snoozeUntil must be in the future" };
		}
		return { ok: true };
	}

	if (requested === "inbox" || requested === "done") {
		if (snoozeUntil) {
			return { ok: false, error: `snoozeUntil is only valid with requested=snoozed` };
		}
		return { ok: true };
	}

	return { ok: false, error: `unsupported requested status: ${requested}` };
}
