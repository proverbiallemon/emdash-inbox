export type SnoozePresetId =
	| "laterToday"
	| "tomorrow9am"
	| "nextWeekMon9am"
	| "debug1min";

export interface SnoozePreset {
	id: SnoozePresetId;
	label: string;
}

export const SNOOZE_PRESETS: SnoozePreset[] = [
	{ id: "laterToday", label: "Later today (3 hours)" },
	{ id: "tomorrow9am", label: "Tomorrow, 9:00 AM" },
	{ id: "nextWeekMon9am", label: "Next week (Mon 9:00 AM)" },
];

export function resolveSnoozePreset(id: SnoozePresetId, now: Date): string {
	switch (id) {
		case "laterToday":
			return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();

		case "tomorrow9am": {
			const d = new Date(now);
			d.setDate(d.getDate() + 1);
			d.setHours(9, 0, 0, 0);
			return d.toISOString();
		}

		case "nextWeekMon9am": {
			const d = new Date(now);
			const day = d.getDay(); // 0=Sun, 1=Mon, ...
			const daysUntilMon = day === 0 ? 1 : (8 - day) % 7 || 7;
			d.setDate(d.getDate() + daysUntilMon);
			d.setHours(9, 0, 0, 0);
			return d.toISOString();
		}

		case "debug1min":
			return new Date(now.getTime() + 60_000).toISOString();
	}
}
