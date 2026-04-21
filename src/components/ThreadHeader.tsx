import * as React from "react";

interface Props {
	subject: string;
	participants: string[];
	messageCount: number;
	children?: React.ReactNode;
}

export function ThreadHeader({ subject, participants, messageCount, children }: Props) {
	const displaySubject = subject || "(no subject)";

	return (
		<div className="border-b pb-3 mb-2">
			<h1 className="text-2xl font-bold">{displaySubject}</h1>
			<div className="text-sm text-muted-foreground mt-1">
				{participants.slice(0, 3).join(", ")}
				{participants.length > 3 ? ` +${participants.length - 3} more` : ""}
				{" · "}
				{messageCount} {messageCount === 1 ? "message" : "messages"}
			</div>
			{children}
		</div>
	);
}
