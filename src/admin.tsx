import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";
import { MAIL_TABS, type TabId } from "./components/FilterTabs";
import { ThreadCard } from "./components/ThreadCard";
import { PageSession } from "./lib/pageSession";
import type { ThreadSummary, MessageView } from "./lib/threadSummary";
import { SnoozePicker } from "./components/SnoozePicker";
import { DateBuckets } from "./components/DateBuckets";
import { ThreadView } from "./components/ThreadView";
import { SettingsPage } from "./components/SettingsPage";
import { ComposeView } from "./components/ComposeView";
import { DraftCard, type DraftListItem } from "./components/DraftCard";
import { OutboxView } from "./components/OutboxView";
import { DaylightShell } from "./daylight/Shell";
import { Dialog } from "./daylight/Dialog";
import { NavigationProvider, useMailNavigation } from "./daylight/navigation";
import { BundleInbox } from "./daylight/BundleInbox";
import { BundleMoveDialog } from "./daylight/BundleMoveDialog";
import { BundleSettingsDialog } from "./daylight/BundleSettingsDialog";
import { BundleResults } from "./daylight/BundleResults";
import type { BundleId } from "./lib/bundles";
import { useInboxPreferences } from "./daylight/preferences";

const API = "/_emdash/api/plugins/emdash-inbox";
function param(key: string) { return new URLSearchParams(window.location.search).get(key); }
function readStatus(): TabId { const value = param("status"); return MAIL_TABS.find(tab => tab.id === value)?.id ?? "inbox"; }
function writeUrl(status: TabId, message: string | null, compose: string | null, query: string, operation: string | null) {
 const url = new URL(window.location.href);
 for (const [key, value] of Object.entries({ status: status === "inbox" ? null : status, message, compose, q: query || null, operation })) {
  if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
 }
 window.history.replaceState(window.history.state, "", url.toString());
}
function searchSummary(message: MessageView & { id: string }): ThreadSummary {
 return { id: message.id, threadId: message.threadId ?? message.messageId, openMessageId: message.id,
  latest: message, previous: null, messageCount: 1, unreadCount: message.read ? 0 : 1, participants: [],
  pinned: message.pinned, sortAt: message.sortAt, snoozeUntil: message.snoozeUntil };
}
function InboxWorkspace() {
 const [operationId, setOperationId] = React.useState<string | null>(() => param("operation"));
 const [bundleRefresh, setBundleRefresh] = React.useState(0);
 const [expandedBundles, setExpandedBundles] = React.useState(new Set<BundleId>());
 const [moving, setMoving] = React.useState<ThreadSummary | null>(null);
 const [manageBundles, setManageBundles] = React.useState(() => param("settings") === "bundles");
 const [status, setStatus] = React.useState<TabId>(readStatus);
 const [selectedMessageId, setSelectedMessageId] = React.useState<string | null>(() => param("message"));
 const [composeId, setComposeId] = React.useState<string | null>(() => param("compose"));
 const [composeSession, setComposeSession] = React.useState(0);
 const [query, setQuery] = React.useState(() => param("q") ?? "");
 const [rows, setRows] = React.useState<ThreadSummary[]>([]);
 const [drafts, setDrafts] = React.useState<DraftListItem[]>([]);
 const [loading, setLoading] = React.useState(true);
 const [error, setError] = React.useState<string | null>(null);
 const [notice, setNotice] = React.useState<string | null>(null);
 const [snoozingThread, setSnoozingThread] = React.useState<ThreadSummary | null>(null);
 const [busyThreadIds, setBusyThreadIds] = React.useState<Set<string>>(new Set());
 const [cursor, setCursor] = React.useState<string | undefined>();
 const [hasMore, setHasMore] = React.useState(false);
 const [loadingMore, setLoadingMore] = React.useState(false);
 const [indexing, setIndexing] = React.useState(false);
 const pages = React.useRef(new PageSession<ThreadSummary>());
 const viewRef = React.useRef("");
 viewRef.current = `${status}|${query}|${operationId ?? ""}`;
 const allow = useMailNavigation();
 const ui = useInboxPreferences();
 const useBundles = !ui.loading && status === "inbox" && !query && Array.isArray(ui.preferences.enabledBundles);
 const debug = React.useMemo(() => param("debug") === "1", []);

 const refetch = React.useCallback(async (nextCursor?: string, append = false, quiet = false) => {
  if (ui.loading) return;
  if (operationId) { setLoading(false); setError(null); setBundleRefresh(value => value + 1); return; }
  if (useBundles) { setLoading(false); setBundleRefresh(value => value + 1); return; }
  if (status === "outbox") { setLoading(false); return; }
  const generation = append ? pageGeneration.current : (pageGeneration.current = pages.current.reset());
  if (append) setLoadingMore(true);
  else if (!quiet) { setLoading(true); setRows([]); setHasMore(false); }
  setError(null); setIndexing(false);
  try {
   if (status === "drafts" && !query) {
    const response = await apiFetch(`${API}/messages/drafts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const data = await parseApiResponse<{ items: DraftListItem[] }>(response, "Failed to load drafts");
    if (pages.current.current(generation)) { setDrafts(data.items); setHasMore(false); }
    return;
   }
   for (let attempt = 0; attempt < 20; attempt++) {
    const response = await apiFetch(`${API}/${query ? "messages/search" : "threads/list"}`, {
     method: "POST", headers: { "Content-Type": "application/json" },
     body: JSON.stringify(query ? { query, limit: 25, cursor: nextCursor } : { status: status === "pinned" ? "all" : status, ...(status === "pinned" ? { pinnedOnly: true } : {}), limit: 25, cursor: nextCursor }),
    });
    const data = await parseApiResponse<{ items: ThreadSummary[] | (MessageView & { id: string })[]; cursor?: string; hasMore: boolean; indexing?: boolean }>(response, "Failed to load messages");
    if (!pages.current.current(generation)) return;
    setIndexing(Boolean(data.indexing));
    if (data.indexing) {
     if (attempt === 19) throw new Error("Mailbox indexing is still in progress. Use Refresh to continue.");
     await new Promise(resolve => setTimeout(resolve, 350));
     if (!pages.current.current(generation)) return;
     continue;
    }
    const incoming = query ? (data.items as (MessageView & { id: string })[]).map(searchSummary) : data.items as ThreadSummary[];
    const items = pages.current.accept(generation, incoming, append);
    if (items) setRows(items);
    setCursor(data.cursor); setHasMore(data.hasMore);
    break;
   }
  } catch (caught) { if (pages.current.current(generation)) setError(caught instanceof Error ? caught.message : String(caught)); }
  finally { if (pages.current.current(generation)) { setLoading(false); setLoadingMore(false); } }
 }, [status, query, useBundles, ui.loading, operationId]);
 const pageGeneration = React.useRef(0);
 React.useEffect(() => { void refetch(); return () => { pages.current.reset(); }; }, [refetch]);
 React.useEffect(() => { writeUrl(status, selectedMessageId, composeId, query, operationId); }, [status, selectedMessageId, composeId, query, operationId]);

 const navigate = async (action: () => void) => { if (await allow()) { action(); setSnoozingThread(null); } };
 const changeStatus = (next: TabId) => navigate(() => { setStatus(next); setOperationId(null); setQuery(""); setSelectedMessageId(null); setComposeId(null); setNotice(null); });
 const openMessage = (id: string) => {
  if (composeId === null && selectedMessageId === id) return;
  void navigate(() => { setComposeId(null); setSelectedMessageId(id); });
 };
 const openCompose = (id = "new") => navigate(() => { setComposeSession(current => current + 1); if (status === "outbox") setStatus("drafts"); setSelectedMessageId(null); setComposeId(id); });
 const search = (next: string) => navigate(() => { setQuery(next); setOperationId(null); setStatus("all"); setComposeId(null); setSelectedMessageId(null); });
 const actOnThread = async (summary: ThreadSummary, action: Record<string, unknown>) => {
  if (busyThreadIds.has(summary.id)) return;
  const actionView = viewRef.current;
  setBusyThreadIds(current => new Set(current).add(summary.id)); setError(null);
  try {
   const response = await apiFetch(`${API}/threads/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: summary.threadId, ...action }) });
   await parseApiResponse(response, "Failed to update thread");
   if (viewRef.current === actionView) await refetch(undefined, false, true);
  } catch (caught) { if (viewRef.current === actionView) setError(caught instanceof Error ? caught.message : String(caught)); }
  finally { setBusyThreadIds(current => { const next = new Set(current); next.delete(summary.id); return next; }); }
 };
 const markRead = React.useCallback((threadId: string) => {
  setBundleRefresh(value => value + 1);
  setRows(current => current.map(row => row.threadId === threadId ? { ...row, unreadCount: 0 } : row));
 }, []);
 const details = selectedMessageId !== null || composeId !== null;
 const folder = MAIL_TABS.find(tab => tab.id === status)?.label ?? "Inbox";
 const hour = new Date().getHours();
 const greeting = `Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}${ui.name ? ", " + ui.name.split(" ")[0] : ""}.`;
 const title = query ? "Search results" : status === "inbox" && !details ? greeting : folder;
 const summary = query ? `Subject and message text matching “${query}”` : new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
 const threadCard = (row: ThreadSummary) => <ThreadCard key={row.id} row={row} selected={selectedMessageId === row.openMessageId} busy={busyThreadIds.has(row.id)}
  onMove={item => void navigate(() => setMoving(item))} onOpen={openMessage} onPinToggle={(item, pinned) => void actOnThread(item, { action: "pin", pinned })}
  onDone={item => void actOnThread(item, { action: "status", status: "done" })} onSnoozeRequest={setSnoozingThread} />;

 return <DaylightShell ui={ui} status={status} onStatus={changeStatus} query={query} onSearch={search} onCompose={() => openCompose()} onManageBundles={() => void navigate(() => setManageBundles(true))}>
  <div className="dl-page-heading"><div><h1>{title}</h1><p>{summary}</p></div><button type="button" className="dl-button dl-primary" onClick={() => openCompose()}>+ New message</button></div>
  {(useBundles || operationId) && error && <p role="alert">{error}</p>}
  {notice && <div className="dl-notice" role="status">{notice} <button type="button" className="dl-button dl-subtle" aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}
  {!details && !query && status === "inbox" && <div className="dl-shortcuts">
   <button type="button" className="dl-shortcut" onClick={() => changeStatus("pinned")}><span className="dl-eyebrow">KEEP CLOSE</span><strong>Pinned mail</strong><small>The mail you want within reach →</small></button>
   <button type="button" className="dl-shortcut" onClick={() => changeStatus("snoozed")}><span className="dl-eyebrow">A LITTLE LATER</span><strong>On your own time</strong><small>Snoozed mail returns when you’re ready →</small></button>
   <button type="button" className="dl-shortcut" onClick={() => changeStatus("drafts")}><span className="dl-eyebrow">PICK UP AGAIN</span><strong>A thought in progress</strong><small>Keep writing where you left off →</small></button>
  </div>}
  {status === "outbox" && !details ? <div className="dl-outbox"><OutboxView /></div> : <div className="dl-content" data-detail={details}>
   <section className="dl-list-column" aria-label={query ? "Matching messages" : "Conversations"}>
    {operationId ? <BundleResults operationId={operationId} refreshKey={bundleRefresh} renderRow={threadCard} onBack={() => void changeStatus("inbox")} /> : useBundles ? <BundleInbox userId={ui.userId} enabled={ui.preferences.enabledBundles} defaultGrouped={ui.preferences.bundledInbox} refreshKey={bundleRefresh} expansion={expandedBundles} onExpansion={setExpandedBundles} renderRow={threadCard} onManage={() => void navigate(() => setManageBundles(true))} onResults={id => void navigate(() => {setOperationId(id); setStatus("done"); setSelectedMessageId(null); setComposeId(null);})} /> : <>
    <div className="dl-list-toolbar"><span>{loading ? "Loading your mail…" : status === "drafts" ? `${drafts.length} drafts` : `${rows.length}${hasMore ? "+" : ""} ${query ? "matching messages" : "conversations"}`}</span><button type="button" className="dl-button dl-subtle" disabled={loading || loadingMore} onClick={() => void refetch()}>Refresh</button></div>
    {indexing && <p role="status" className="dl-muted">Updating the mailbox index…</p>}
    {error && <p role="alert">{error}</p>}
    {loading ? <div aria-label="Loading mail" aria-busy="true">{[0, 1, 2, 3].map(item => <div key={item} className="dl-skeleton" />)}</div> : status === "drafts" && !query ? <>
     {drafts.map(draft => <DraftCard key={draft.id} draft={draft} onOpen={openCompose} />)}
     {!drafts.length && !error && <div className="dl-empty"><h2>A fresh start.</h2><p className="dl-muted">Start a new message. Save it as a draft whenever you like.</p></div>}
    </> : <>
     {query ? <div className="dl-bucket-rows">{rows.map(threadCard)}</div> : <DateBuckets rows={rows} field={status === "snoozed" ? "snoozeUntil" : "sortAt"} direction={status === "snoozed" ? "future" : "past"} renderRow={threadCard} />}
     {!rows.length && !error && !indexing && <div className="dl-empty"><h2>{query ? hasMore ? "Keep looking." : "No matches yet." : status === "inbox" ? "A little breathing room." : "Nothing here yet."}</h2><p className="dl-muted">{query ? hasMore ? "There’s more of your mailbox to search." : "Try another word or phrase." : status === "inbox" ? "Your inbox is clear. Enjoy the space." : `Mail in ${folder.toLowerCase()} will appear here.`}</p></div>}
     {hasMore && <button type="button" className="dl-button dl-load-more" disabled={loadingMore} onClick={() => void refetch(cursor, true)}>{loadingMore ? "Loading…" : query ? "Continue search" : "Load more conversations"}</button>}
    </>}
    </>}
   </section>
   {details && <section className="dl-detail" aria-label={composeId ? "Compose message" : "Conversation"}>
    {composeId !== null ? <ComposeView key={`${composeId}:${composeSession}`} draftId={composeId === "new" ? null : composeId} onSent={() => setNotice("Message accepted for delivery. You can review it in All mail.")} onClose={() => { setComposeId(null); void refetch(undefined, false, true); }} /> :
     <ThreadView key={selectedMessageId} messageId={selectedMessageId!} debug={debug} senderAddress={ui.senderAddress} onRead={markRead} onChanged={() => void refetch(undefined, false, true)} onBack={() => navigate(() => setSelectedMessageId(null))} />}
   </section>}
  </div>}
  {manageBundles && !ui.loading && <BundleSettingsDialog ui={ui} onClose={() => setManageBundles(false)} />}
  {moving && <BundleMoveDialog row={moving} onRefresh={() => void refetch()} onClose={() => {setMoving(null); requestAnimationFrame(() => {if(document.activeElement === document.body) document.querySelector<HTMLElement>("[data-bundle-focus]")?.focus();});}} onChanged={message => {setNotice(message); void refetch(undefined, false, true);}} />}
  {snoozingThread && <Dialog title="Come back to this" onClose={() => setSnoozingThread(null)}><SnoozePicker debug={debug} onCancel={() => setSnoozingThread(null)} onConfirm={until => { const row = snoozingThread; setSnoozingThread(null); void actOnThread(row, { action: "status", status: "snoozed", snoozeUntil: until }); }} /></Dialog>}
 </DaylightShell>;
}
function InboxPage() { return <NavigationProvider><InboxWorkspace /></NavigationProvider>; }
export const pages: PluginAdminExports["pages"] = { "/": InboxPage, "/settings": SettingsPage };
