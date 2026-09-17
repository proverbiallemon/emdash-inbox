import * as React from "react";
import { bucketize, type Direction } from "../lib/bucketize";

interface Row {
	id: string;
	pinned?: boolean;
	sortAt: string;
	snoozeUntil: string | null;
}

interface Props<T extends Row> {
	rows: T[];
	field: "sortAt" | "snoozeUntil";
	direction: Direction;
	now?: Date;
	renderRow: (row: T) => React.ReactNode;
}

export function DateBuckets<T extends Row>({
	rows,
	field,
	direction,
	now,
	renderRow,
}: Props<T>) {
	const buckets = bucketize(rows.filter(row => !row.pinned), (r) => r[field], now ?? new Date(), direction);

	const sections: { label: string; rows: T[] }[] = [
		{ label: "Pinned", rows: rows.filter(row => row.pinned) },
		{ label: "Today", rows: buckets.today },
		{
			label: direction === "future" ? "Tomorrow" : "Yesterday",
			rows: buckets.yesterday,
		},
		{ label: "This week", rows: buckets.thisWeek },
		{ label: direction === "future" ? "Later" : "Older", rows: buckets.older },
	];

	return (
		<div className="dl-buckets">
			{sections
				.filter((s) => s.rows.length > 0)
				.map((s) => (
					<div key={s.label}>
						<div className="dl-bucket-label">
							{s.label}
						</div>
						<div className="dl-bucket-rows">{s.rows.map(renderRow)}</div>
					</div>
				))}
		</div>
	);
}
