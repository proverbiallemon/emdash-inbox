export type Direction = "past" | "future";

export interface Buckets<T> {
	today: T[];
	yesterday: T[];
	thisWeek: T[];
	older: T[];
}

function startOfDay(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function bucketize<T>(
	rows: T[],
	field: string | ((row: T) => string | null | undefined),
	now: Date,
	direction: Direction,
): Buckets<T> {
	const todayStart = startOfDay(now);
	const dayMs = 24 * 60 * 60 * 1000;

	const out: Buckets<T> = { today: [], yesterday: [], thisWeek: [], older: [] };

	const getValue =
		typeof field === "function"
			? field
			: (r: T) => (r as unknown as { data: Record<string, unknown> }).data[field] as string | undefined;

	for (const row of rows) {
		const iso = getValue(row) as string | undefined;
		if (!iso) continue;
		const t = Date.parse(iso);
		if (Number.isNaN(t)) continue;

		const rowDayStart = startOfDay(new Date(t));
		const daysDiff = Math.round((rowDayStart - todayStart) / dayMs);

		if (direction === "past") {
			if (daysDiff === 0) out.today.push(row);
			else if (daysDiff === -1) out.yesterday.push(row);
			else if (daysDiff < -1 && daysDiff >= -7) out.thisWeek.push(row);
			else if (daysDiff < -7) out.older.push(row);
			// future rows skipped in past-direction mode
		} else {
			// future direction (for Snoozed tab): yesterday-slot reused for tomorrow
			if (daysDiff === 0) out.today.push(row);
			else if (daysDiff === 1) out.yesterday.push(row);
			else if (daysDiff > 1 && daysDiff <= 7) out.thisWeek.push(row);
			else if (daysDiff > 7) out.older.push(row);
			// past rows skipped in future-direction mode
		}
	}

	return out;
}
