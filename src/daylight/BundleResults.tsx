import * as React from 'react';
import { postInbox } from '../lib/attachmentClient';
import { PageSession } from '../lib/pageSession';
import type { ThreadSummary } from '../lib/threadSummary';

interface Outcome {
 id: string;
 threadId: string;
 openMessageId: string;
 outcome: string;
 reason?: string;
 summary: ThreadSummary | null;
}
interface Props {
 operationId: string;
 refreshKey: number;
 renderRow: (row: ThreadSummary) => React.ReactNode;
 onBack: () => void;
}

export function BundleResults({operationId, refreshKey, renderRow, onBack}: Props) {
 const [rows, setRows] = React.useState<Outcome[]>([]);
 const [error, setError] = React.useState('');
 const [busy, setBusy] = React.useState(false);
 const [cursor, setCursor] = React.useState<string>();
 const [more, setMore] = React.useState(false);
 const pages = React.useRef(new PageSession<Outcome>());
 const generation = React.useRef(0);
 const lock = React.useRef(false);

 const load = React.useCallback(async (append = false, next?: string) => {
  if (lock.current && append) return;
  lock.current = true;
  const current = append ? generation.current : (generation.current = pages.current.reset());
  setBusy(true);
  setError('');
  if (!append) {
   setCursor(undefined);
   setMore(false);
  }
  try {
   const data = await postInbox<{items: Omit<Outcome, 'id'>[]; hasMore: boolean; cursor?: string}>(
    'bundles/done-threads', {operationId, limit: 25, ...(next ? {cursor: next} : {})},
   );
   if (!pages.current.current(current)) return;
   const accepted = pages.current.accept(current, data.items.map(item => ({...item, id: item.threadId})), append);
   if (accepted) setRows(accepted);
   setMore(data.hasMore);
   setCursor(data.cursor);
  } catch (caught) {
   if (pages.current.current(current)) {
    setError(caught instanceof Error ? caught.message : 'Could not load operation results.');
   }
  } finally {
   if (pages.current.current(current)) {
    lock.current = false;
    setBusy(false);
   }
  }
 }, [operationId]);

 // Reads and mutations restart the authoritative page sequence. A late append
 // from the old generation cannot restore stale summaries or its old cursor.
 React.useEffect(() => {
  void load();
  return () => {
   pages.current.reset();
   lock.current = false;
  };
 }, [load, refreshKey]);

 return <section className="dl-bundle-results" aria-label="Bundle operation results">
  <div className="dl-bundle-toolbar">
   <button className="dl-button" onClick={onBack}>Back to Inbox</button>
   <h2>Bundle results</h2>
  </div>
  <p className="dl-muted">The prepared conversations and their outcomes. Current folder labels reflect any later changes.</p>
  {error && <p role="alert">{error}</p>}
  {busy && <p role="status">Loading results…</p>}
  {rows.map(row => <div key={row.threadId} className="dl-bundle-result">
   <p>
    <strong>{row.outcome === 'done' ? 'Marked done' : row.outcome === 'skipped' ? 'Kept unchanged' : row.outcome === 'failed' ? 'Needs attention' : 'Pending'}</strong>
    {row.reason ? ` · ${row.reason.replaceAll('_', ' ')}` : ''}
    {row.summary ? ` · Currently ${row.summary.latest.status}` : ''}
   </p>
   {row.summary ? renderRow(row.summary) : <p>Conversation is no longer available.</p>}
  </div>)}
  {error && <button className="dl-button" disabled={busy} onClick={() => void load()}>Retry results</button>}
  {more && <button className="dl-button" disabled={busy} onClick={() => void load(true, cursor)}>Load more results</button>}
 </section>;
}
