import * as React from "react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";

const API = "/_emdash/api/plugins/emdash-inbox";

/**
 * Plugin-owned settings surface. EmDash's settingsSchema never grew the
 * auto-generated admin UI its type annotation promises, so the plugin
 * renders and persists its two settings itself via settings/get + save.
 */
export function SettingsPage() {
	const [senderAddress, setSenderAddress] = React.useState("");
	const [inboundSecret, setInboundSecret] = React.useState("");
	const [secretSet, setSecretSet] = React.useState(false);
	const [loading, setLoading] = React.useState(true);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [saved, setSaved] = React.useState(false);

	React.useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await apiFetch(`${API}/settings/get`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				});
				const data = await parseApiResponse<{ senderAddress: string; inboundSecretSet: boolean }>(
					res,
					"Failed to load settings",
				);
				if (cancelled) return;
				setSenderAddress(data.senderAddress);
				setSecretSet(data.inboundSecretSet);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const generateSecret = () => {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		setInboundSecret(btoa(String.fromCharCode(...bytes)));
	};

	const handleSave = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			const body: Record<string, string> = { senderAddress };
			if (inboundSecret.trim() !== "") body.inboundSecret = inboundSecret.trim();
			const res = await apiFetch(`${API}/settings/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				let message = `save failed (${res.status})`;
				try {
					const parsed = (await res.json()) as { error?: { message?: string } };
					if (parsed?.error?.message) message = parsed.error.message;
				} catch {
					// non-JSON body — keep the status message
				}
				throw new Error(message);
			}
			if (inboundSecret.trim() !== "") {
				setSecretSet(true);
				setInboundSecret("");
			}
			setSaved(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const inputClass = "w-full text-sm border rounded px-2 py-1 disabled:opacity-50";

	if (loading) return <div className="text-sm text-muted-foreground">Loading settings…</div>;

	return (
		<div className="space-y-6 max-w-xl">
			<a
				href="/_emdash/admin/plugins/emdash-inbox"
				className="text-sm text-muted-foreground hover:text-foreground"
			>
				← Inbox
			</a>
			<div>
				<h1 className="text-3xl font-bold">Inbox Settings</h1>
				<p className="text-muted-foreground mt-1">
					Delivery and inbound configuration for emdash-inbox.
				</p>
			</div>
			{error && (
				<div className="p-2 rounded border border-destructive/50 bg-destructive/5 text-sm text-destructive">
					{error}
				</div>
			)}
			{saved && !error && (
				<div className="p-2 rounded border border-emerald-500/50 bg-emerald-500/5 text-sm">
					Settings saved.
				</div>
			)}
			<label className="block text-xs font-medium">
				Sender address
				<input
					type="text"
					className={inputClass}
					value={senderAddress}
					disabled={busy}
					placeholder="inbox@your.domain"
					onChange={(e) => setSenderAddress(e.target.value)}
				/>
				<span className="block font-normal text-muted-foreground mt-1">
					Outbound mail is sent from this address. Its domain must be onboarded for
					Cloudflare Email Sending.
				</span>
			</label>
			<label className="block text-xs font-medium">
				Inbound secret {secretSet && <span className="text-muted-foreground">(configured — enter a value to rotate)</span>}
				<div className="flex gap-2">
					<input
						type="text"
						className={inputClass}
						value={inboundSecret}
						disabled={busy}
						placeholder={secretSet ? "••••••••  (unchanged unless replaced)" : "long random string"}
						onChange={(e) => setInboundSecret(e.target.value)}
					/>
					<button
						type="button"
						className="text-xs px-3 py-1 border rounded hover:bg-muted shrink-0 disabled:opacity-50"
						disabled={busy}
						onClick={generateSecret}
					>
						Generate
					</button>
				</div>
				<span className="block font-normal text-muted-foreground mt-1">
					Shared with the inbound sidecar worker (its X-Inbound-Secret header). Copy it
					into the worker&apos;s configuration before saving — it isn&apos;t shown again.
				</span>
			</label>
			<button
				type="button"
				className="text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
				disabled={busy}
				onClick={() => void handleSave()}
			>
				{busy ? "Saving…" : "Save settings"}
			</button>
		</div>
	);
}
