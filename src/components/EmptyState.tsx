import * as React from "react";
import type { StatusFilter } from "./FilterTabs";

const COPY: Record<StatusFilter, { title: string; body?: React.ReactNode }> = {
	inbox: { title: "Inbox zero — well played." },
	snoozed: { title: "Nothing snoozed." },
	done: { title: "Nothing finished yet." },
	all: {
		title: "No messages yet.",
		body: (
			<>
				Send one with <code className="font-mono text-xs">ctx.email.send()</code>, or route an inbound
				email through the worker at{" "}
				<code className="font-mono text-xs">examples/inbound-email-worker</code>.
			</>
		),
	},
};

interface Props {
	status: StatusFilter;
}

export function EmptyState({ status }: Props) {
	const c = COPY[status];
	return (
		<div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
			<div className="font-medium mb-1">{c.title}</div>
			{c.body && <div>{c.body}</div>}
		</div>
	);
}
