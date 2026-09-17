export type StatusFilter = "inbox" | "snoozed" | "done" | "all";
export type TabId = StatusFilter | "pinned" | "drafts" | "outbox";
export const MAIL_TABS: { id: TabId; label: string }[] = [
 { id: "inbox", label: "Inbox" }, { id: "pinned", label: "Pinned" },
 { id: "snoozed", label: "Snoozed" }, { id: "drafts", label: "Drafts" },
 { id: "outbox", label: "Outbox" }, { id: "done", label: "Done" }, { id: "all", label: "All mail" },
];
export function FilterTabs({ current, onChange }: { current: TabId; onChange: (next: TabId) => void }) {
 return <nav className="dl-nav" aria-label="Mailbox folders">{MAIL_TABS.map(tab =>
  <button type="button" key={tab.id} aria-current={current === tab.id ? "page" : undefined} onClick={() => onChange(tab.id)}>{tab.label}</button>,
 )}</nav>;
}
