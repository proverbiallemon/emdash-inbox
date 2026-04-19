/**
 * Admin UI — runs inside the EmDash admin dashboard at
 * /_emdash/admin/plugins/emdash-inbox/*.
 *
 * Imported by the admin registry via the `./admin` package export, wired
 * from the plugin descriptor's `adminEntry`.
 */

import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const API = "/_emdash/api/plugins/emdash-inbox";

interface MessageDoc {
	messageId: string;
	direction: "inbound" | "outbound";
	from: string;
	to: string;
	subject: string;
	bodyText: string;
	bodyHtml: string | null;
	receivedAt: string;
	source: string;
	status: "inbox" | "snoozed" | "done" | "archived";
	pinned: boolean;
}

interface MessageRow {
	id: string;
	data: MessageDoc;
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function InboxPage() {
	const [rows, setRows] = React.useState<MessageRow[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);

	React.useEffect(() => {
		void (async () => {
			try {
				const res = await apiFetch(`${API}/messages/list`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				});
				const data = await parseApiResponse<{ items: MessageRow[] }>(
					res,
					"Failed to load messages",
				);
				setRows(data.items);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		})();
	}, []);

	if (loading) {
		return <div className="p-6 text-muted-foreground">Loading…</div>;
	}

	if (error) {
		return (
			<div className="p-6 rounded-lg border border-destructive/50 bg-destructive/5 text-sm text-destructive">
				{error}
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-3xl font-bold">Inbox</h1>
				<p className="text-muted-foreground mt-1">
					All messages that passed through this site — {rows.length} total.
				</p>
			</div>

			{rows.length === 0 ? (
				<div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
					No messages yet. Send one with{" "}
					<code className="font-mono text-xs">ctx.email.send()</code>, or route
					an inbound email through the worker at{" "}
					<code className="font-mono text-xs">
						examples/inbound-email-worker
					</code>
					.
				</div>
			) : (
				<div className="border rounded-lg overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b bg-muted/50">
								<th className="text-left p-3 font-medium w-32">When</th>
								<th className="text-left p-3 font-medium w-24">Direction</th>
								<th className="text-left p-3 font-medium">From / To</th>
								<th className="text-left p-3 font-medium">Subject</th>
								<th className="text-left p-3 font-medium w-20">Status</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => {
								const m = r.data;
								const counterparty =
									m.direction === "inbound" ? m.from : m.to;
								return (
									<tr
										key={r.id}
										className="border-b last:border-0 hover:bg-muted/30"
									>
										<td className="p-3 text-muted-foreground whitespace-nowrap">
											{formatDate(m.receivedAt)}
										</td>
										<td className="p-3">
											<span
												className={
													m.direction === "inbound"
														? "text-emerald-500"
														: "text-sky-500"
												}
											>
												{m.direction === "inbound" ? "← in" : "→ out"}
											</span>
										</td>
										<td className="p-3 truncate max-w-xs">{counterparty}</td>
										<td className="p-3 truncate max-w-md">
											{m.subject || (
												<span className="italic text-muted-foreground">
													(no subject)
												</span>
											)}
										</td>
										<td className="p-3 text-xs text-muted-foreground">
											{m.status}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

export const pages: PluginAdminExports["pages"] = {
	"/": InboxPage as unknown as PluginAdminExports["pages"][string],
};
