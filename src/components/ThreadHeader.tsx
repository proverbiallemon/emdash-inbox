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
		<div className="dl-thread-header">
			<h1 className="dl-thread-title">{displaySubject}</h1>
			<div className="dl-muted">
				{participants.slice(0, 3).join(", ")}
				{participants.length > 3 ? ` +${participants.length - 3} more` : ""}
				{" · "}
				{messageCount} {messageCount === 1 ? "message" : "messages"}
			</div>
			{children}
		</div>
	);
}
