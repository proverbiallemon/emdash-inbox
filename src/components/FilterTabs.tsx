import * as React from "react";

export type StatusFilter = "inbox" | "snoozed" | "done" | "all";

const TABS: { id: StatusFilter; label: string }[] = [
	{ id: "inbox", label: "Inbox" },
	{ id: "snoozed", label: "Snoozed" },
	{ id: "done", label: "Done" },
	{ id: "all", label: "All" },
];

interface Props {
	current: StatusFilter;
	onChange: (next: StatusFilter) => void;
}

export function FilterTabs({ current, onChange }: Props) {
	return (
		<div className="flex gap-1 border-b">
			{TABS.map((tab) => {
				const active = tab.id === current;
				return (
					<button
						key={tab.id}
						type="button"
						onClick={() => onChange(tab.id)}
						className={
							"px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors " +
							(active
								? "border-foreground text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground")
						}
					>
						{tab.label}
					</button>
				);
			})}
		</div>
	);
}
