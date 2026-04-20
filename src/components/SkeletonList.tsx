import * as React from "react";

export function SkeletonList() {
	return (
		<div className="space-y-2">
			{[0, 1, 2, 3].map((i) => (
				<div
					key={i}
					className="relative border rounded-lg pl-4 pr-3 py-3 overflow-hidden animate-pulse"
				>
					<span className="absolute left-0 top-0 bottom-0 w-[3px] bg-muted-foreground/30" />
					<div className="h-3 w-1/3 bg-muted rounded mb-2" />
					<div className="h-3 w-2/3 bg-muted rounded" />
				</div>
			))}
		</div>
	);
}
