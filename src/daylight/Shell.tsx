import * as React from "react";
import { createPortal } from "react-dom";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { daylightStyles } from "./styles";
import type { useInboxPreferences } from "./preferences";
import { FilterTabs, type TabId } from "../components/FilterTabs";

/** Reparent the same portal host so changing window mode never remounts an editor. */
function Surface({ fullWindow, children }: { fullWindow: boolean; children: React.ReactNode }) {
	const anchor = React.useRef<HTMLDivElement>(null);
	const [host] = React.useState(() => typeof document === "undefined" ? null : document.createElement("div"));
	React.useLayoutEffect(() => {
		if (!host) return;
		const focused = document.activeElement as HTMLElement | null;
		// Reparenting disconnects native dialogs from the top layer. Reopen them
		// after moving the host while preserving the editor and modal React state.
		const modals = [...host.querySelectorAll<HTMLDialogElement>("dialog[open]")];
		for (const dialog of modals) dialog.close();
		(fullWindow ? document.body : anchor.current)?.appendChild(host);
		host.className = fullWindow ? "dl-portal dl-portal-full" : "dl-portal";
		for (const dialog of modals) dialog.showModal();
		if (focused && host.contains(focused)) focused.focus();
		if (!fullWindow) return;
		const overflow = document.body.style.overflow;
		const backgrounds = [...document.body.children].filter(node => node !== host && node instanceof HTMLElement) as HTMLElement[];
		const previous = backgrounds.map(node => [node, node.inert] as const);
		for (const [node] of previous) node.inert = true;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = overflow;
			for (const [node, inert] of previous) node.inert = inert;
		};
	}, [host, fullWindow]);
	React.useEffect(() => () => host?.remove(), [host]);
	return <><div ref={anchor} className="dl-mount" />{host && createPortal(children, host)}</>;
}

interface Props {
	ui: ReturnType<typeof useInboxPreferences>;
	status: TabId; onStatus: (status: TabId) => void;
	query: string; onSearch: (query: string) => void;
	onCompose: () => void; children: React.ReactNode;
}

export function DaylightShell({ ui, status, onStatus, query, onSearch, onCompose, children }: Props) {
	const [appearance, setAppearance] = React.useState(false);
	const [drawer, setDrawer] = React.useState(false);
	const [search, setSearch] = React.useState(query);
	React.useEffect(() => setSearch(query), [query]);
	const navigate = (next: TabId) => { onStatus(next); setDrawer(false); };
	const controls = <FilterTabs current={status} onChange={navigate} />;
	const settings = <button type="button" className="dl-button dl-subtle" onClick={() => { setDrawer(false); setAppearance(true); }}><Icon name="settings" />Appearance &amp; layout</button>;
	return <Surface fullWindow={ui.preferences.fullWindow}>
		<style>{daylightStyles}</style>
		<div className="dl-root" data-navigation={ui.preferences.navigation} data-full-window={ui.preferences.fullWindow}>
			<header className="dl-topbar">
				<button type="button" className="dl-brand" onClick={() => onStatus("inbox")}>inbox</button>
				<form className="dl-search" role="search" onSubmit={event => { event.preventDefault(); onSearch(search.trim()); }}>
					<Icon name="search" /><input aria-label="Search your mail" placeholder="Search your mail" maxLength={1000} value={search} onChange={event => setSearch(event.target.value)} />
					{search && <button type="button" className="dl-icon-button" aria-label="Clear search" onClick={() => { setSearch(""); onSearch(""); }}>×</button>}
					<button type="submit" className="dl-search-submit">Search</button>
				</form>
				<a className="dl-dashboard-link" href="/_emdash/admin/">← EmDash dashboard</a>
				<button type="button" className="dl-icon-button dl-layout-trigger" title="Appearance and layout" aria-label="Appearance and layout" onClick={() => setAppearance(true)}><Icon name="settings" /></button>
				<button type="button" className="dl-icon-button dl-menu-trigger" aria-label="Mail navigation" onClick={() => setDrawer(true)}>☰</button>
			</header>
			<div className="dl-top-navigation">{controls}</div>
			<div className="dl-workspace">
				<aside className="dl-sidebar" aria-label="Mail sidebar">
					<p className="dl-eyebrow">YOUR MAILBOX</p>
					{controls}
					<div className="dl-sidebar-footer">{settings}<a href="/_emdash/admin/plugins/emdash-inbox/settings">Mail settings</a><a href="/_emdash/admin/">← EmDash dashboard</a></div>
				</aside>
				<main className="dl-main" id="daylight-mail">{children}</main>
			</div>
			<footer className="dl-app-footer">{settings}<button type="button" className="dl-button dl-subtle" disabled={ui.loading || ui.saving} onClick={() => void ui.update({ ...ui.preferences, fullWindow: !ui.preferences.fullWindow })}>{ui.preferences.fullWindow ? "Use dashboard view" : "Expand Inbox"}</button><a href="/_emdash/admin/plugins/emdash-inbox/settings">Mail settings</a></footer>
			{ui.error && !appearance && <p role="alert">{ui.error}</p>}
			{appearance && <Dialog title="Make room for your mail" onClose={() => setAppearance(false)}>
				<p className="dl-muted">Choose where your mail navigation lives.</p>
				<div className="dl-layout-options">
					{(["top", "left"] as const).map(layout => <button type="button" key={layout} className="dl-layout-option" aria-pressed={ui.preferences.navigation === layout} disabled={ui.loading || ui.saving} onClick={() => void ui.update({ ...ui.preferences, navigation: layout })}>
						<span className={`dl-layout-preview dl-layout-preview-${layout}`}><i /><i /></span><strong>{layout === "top" ? "Top navigation" : "Left navigation"}</strong><span>{layout === "top" ? "An open, spacious inbox." : "Your folders always in reach."}</span>
					</button>)}
				</div>
				<label className="dl-checkbox-label"><input type="checkbox" checked={ui.preferences.fullWindow} disabled={ui.loading || ui.saving} onChange={event => void ui.update({ ...ui.preferences, fullWindow: event.target.checked })} />Use the full window</label>
				<p className="dl-muted">You can always return to the EmDash dashboard.</p>
				{ui.error && <p role="alert" className="dl-error">{ui.error}</p>}
				<p className="dl-muted" role="status">{ui.loading ? "Loading your layout…" : ui.saving ? "Saving your layout…" : ui.error ? "Your layout could not be saved." : ui.canSave ? "Saved for your account." : "This layout applies to your current visit."}</p>
				<button type="button" className="dl-button dl-primary" onClick={() => setAppearance(false)}>Done</button>
			</Dialog>}
			{drawer && <Dialog title="Your mailbox" onClose={() => setDrawer(false)}><div className="dl-drawer-navigation">{controls}</div><button type="button" className="dl-button dl-primary" onClick={() => { onCompose(); setDrawer(false); }}>+ New message</button>{settings}<a className="dl-drawer-dashboard" href="/_emdash/admin/">← EmDash dashboard</a></Dialog>}
		</div>
	</Surface>;
}
