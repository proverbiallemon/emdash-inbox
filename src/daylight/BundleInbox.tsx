import * as React from 'react';
import { BUNDLE_DEFINITIONS, type BundleId } from '../lib/bundles';
import type { ThreadSummary } from '../lib/threadSummary';
import { postInbox } from '../lib/attachmentClient';
import { PageSession } from '../lib/pageSession';
import { Dialog } from './Dialog';
import { BundleRules } from './BundleSettingsDialog';
import { BundleOperationContent, BundleOperationDialog } from './BundleOperationDialog';
import { useBundleOperation } from './useBundleOperation';
interface Overview {totalCount:number;unreadCount:number;indexing?:boolean;bundles:{id:BundleId;count:number;unreadCount:number;senders:string[]}[];}
interface Props {userId:string|null;enabled:BundleId[];defaultGrouped:boolean;refreshKey:number;renderRow:(row:ThreadSummary)=>React.ReactNode;onManage:()=>void;onResults:(id:string)=>void;expansion?:Set<BundleId>;onExpansion?:(value:Set<BundleId>)=>void;}
function BundlePage({section,enabled,refreshKey,renderRow}:{section:'conversations'|BundleId;enabled:BundleId[];refreshKey:number;renderRow:Props['renderRow']}) {
 const [rows,setRows]=React.useState<ThreadSummary[]>([]);const [cursor,setCursor]=React.useState<string>();const [more,setMore]=React.useState(false);const [busy,setBusy]=React.useState(false);const [error,setError]=React.useState('');const [indexing,setIndexing]=React.useState(false);
 const pageElement=React.useRef<HTMLDivElement>(null);const removedFocus=React.useRef<HTMLElement|null>(null);
 const pages=React.useRef(new PageSession<ThreadSummary>());const generation=React.useRef(0);const lock=React.useRef(false);const enabledKey=enabled.join(',');
 const load=React.useCallback(async(append=false,next?:string)=>{
  if(append&&lock.current)return;lock.current=true;const current=append?generation.current:(generation.current=pages.current.reset());setBusy(true);setError('');
  try {const data=await postInbox<{items:ThreadSummary[];hasMore:boolean;cursor?:string;indexing?:boolean}>('bundles/list',{section,enabled:enabledKey?enabledKey.split(','):[],limit:25,...(next?{cursor:next}:{})});if(!pages.current.current(current))return;
   setIndexing(Boolean(data.indexing));if(data.indexing){setMore(false);return;}const accepted=pages.current.accept(current,data.items,append);if(accepted){removedFocus.current=pageElement.current?.contains(document.activeElement)?document.activeElement as HTMLElement:null;setRows(accepted);}setMore(data.hasMore);setCursor(data.cursor);
  }catch(e){if(pages.current.current(current))setError(e instanceof Error?e.message:'Could not load these conversations.');}finally{if(pages.current.current(current)){lock.current=false;setBusy(false);}}
 },[section,enabledKey]);
 React.useEffect(()=>{void load();return()=>{pages.current.reset();lock.current=false;};},[load,refreshKey]);
 React.useLayoutEffect(()=>{const previous=removedFocus.current;if(previous&&!previous.isConnected){const fallback=pageElement.current?.closest(".dl-bundle")?.querySelector<HTMLElement>(".dl-bundle-heading")??document.querySelector<HTMLElement>("[data-bundle-focus]");fallback?.focus();}removedFocus.current=null;},[rows]);
 return <div ref={pageElement} className="dl-bundle-page">{error&&<p role="alert">{error}</p>}{indexing&&<p role="status">Mailbox indexing is in progress. Refresh to continue.</p>}{busy&&!rows.length?<p role="status">Loading conversations…</p>:<div className="dl-bucket-rows">{rows.map(renderRow)}</div>}{(error||indexing)&&<button className="dl-button" disabled={busy} onClick={()=>void load()}>Retry conversations</button>}{more&&<button className="dl-button dl-load-more" disabled={busy} onClick={()=>void load(true,cursor)}>{busy?'Loading…':`Load more ${section==='conversations'?'conversations':section}`}</button>}</div>;
}
export function BundleInbox({userId,enabled,defaultGrouped,refreshKey,renderRow,onManage,onResults,expansion,onExpansion}:Props) {
 const [grouped,setGrouped]=React.useState(defaultGrouped);const [localExpanded,setLocalExpanded]=React.useState(new Set<BundleId>());const expanded=expansion??localExpanded;
 const setExpanded=(value:Set<BundleId>)=>{setLocalExpanded(value);onExpansion?.(value);};
 const [overview,setOverview]=React.useState<Overview|null>(null);const [error,setError]=React.useState('');const [busy,setBusy]=React.useState(true);const [revision,setRevision]=React.useState(0);const [rules,setRules]=React.useState<BundleId|null>(null);const [operationDialog,setOperationDialog]=React.useState(false);
 const removedOverviewFocus=React.useRef<HTMLElement|null>(null);
 const id=React.useId();const toolbar=React.useRef<HTMLDivElement>(null);const refresh=()=>setRevision(value=>value+1);const operation=useBundleOperation(userId,refresh);
 React.useEffect(()=>setGrouped(defaultGrouped),[defaultGrouped]);
 React.useEffect(()=>{let active=true;setBusy(true);setError('');postInbox<Overview>('bundles/overview',{}).then(data=>{if(!Array.isArray(data.bundles))throw new Error('Bundle overview is unavailable.');if(active){removedOverviewFocus.current=toolbar.current?.parentElement?.contains(document.activeElement)?document.activeElement as HTMLElement:null;setOverview(data);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[refreshKey,revision,enabled.join(',')]);
 React.useLayoutEffect(()=>{if(removedOverviewFocus.current&&!removedOverviewFocus.current.isConnected&&document.activeElement===document.body)toolbar.current?.focus();removedOverviewFocus.current=null;},[overview]);
 React.useEffect(()=>{if(operation.reference){setExpanded(new Set(expanded).add(operation.reference.bundle));}},[operation.reference?.bundle]);
 const dismiss=()=>{operation.dismiss();setOperationDialog(false);refresh();toolbar.current?.focus();};
 const showResults=(operationId:string)=>{setOperationDialog(false);onResults(operationId);};
 const token=refreshKey+revision;
 return <div className="dl-bundle-inbox">
  <div className="dl-bundle-toolbar" tabIndex={-1} ref={toolbar} data-bundle-focus>
   <div className="dl-bundle-toggle" aria-label="Inbox presentation"><button className="dl-button" aria-pressed={grouped} onClick={()=>setGrouped(true)}>Bundled inbox</button><button className="dl-button" aria-pressed={!grouped} onClick={()=>setGrouped(false)}>All conversations</button></div>
   <button className="dl-button dl-subtle" onClick={onManage}>Manage bundles</button><button className="dl-button dl-subtle" disabled={busy} onClick={refresh}>Refresh</button>
  </div>
  {error&&<p role="alert">{error}</p>}
  {overview?.indexing&&<p role="status">Updating the mailbox index. Counts are still being prepared. Use Refresh to continue.</p>}
  {!overview&&busy&&<p role="status">Loading your Inbox…</p>}
  <section aria-label="Individual conversations"><h2 className="dl-bundle-section-title">{grouped?'Conversations':'All conversations'}</h2><BundlePage section="conversations" enabled={grouped?enabled:[]} refreshKey={token} renderRow={renderRow}/></section>
  {grouped&&<section aria-label="Bundles"><div className="dl-bundle-section-heading"><h2 className="dl-bundle-section-title">Bundles</h2><span className="dl-muted">Related conversations, together</span></div>
   {overview && !overview.indexing && !error && !busy && !operation.reference && !overview.bundles.some(item => enabled.includes(item.id) && item.count > 0) && <p className="dl-muted">{enabled.length ? "No grouped matches yet. Your mail is shown in Conversations." : "All bundles are turned off. Your mail is shown in Conversations."}</p>}
   {BUNDLE_DEFINITIONS.filter(item=>(enabled.includes(item.id)&&(overview?.bundles.find(value=>value.id===item.id)?.count??0)>0)||operation.reference?.bundle===item.id).map(item=>{
    const count=overview?.bundles.find(value=>value.id===item.id);const open=expanded.has(item.id);const saved=operation.reference?.bundle===item.id;
    return <section key={item.id} className="dl-bundle" data-bundle={item.id}>
     <button type="button" className="dl-bundle-heading" aria-label={`${open?'Collapse':'Expand'} ${item.title} bundle, ${count?.count??0} conversations, ${count?.unreadCount??0} unread`} aria-expanded={open} aria-controls={`${id}-${item.id}`} onClick={()=>{const next=new Set(expanded);if(open)next.delete(item.id);else next.add(item.id);setExpanded(next);}}>
      <span className="dl-bundle-badge" aria-hidden="true">{item.title[0]}</span><span className="dl-bundle-summary"><span><strong>{item.title}</strong><span className="dl-bundle-unread">{count?.unreadCount??0} unread</span></span><small>{count?.count??0} conversations{count?.senders.length?` · ${count.senders.join(', ')}`:''}</small></span><span className="dl-bundle-chevron" aria-hidden="true" data-open={open}/>
     </button>
     <div id={`${id}-${item.id}`} hidden={!open}>{open&&<div className="dl-bundle-body">
      {saved?<BundleOperationContent operation={operation} onResults={showResults} onDismiss={dismiss}/>:<div className="dl-bundle-actions"><span>{count?.count} conversations · {count?.unreadCount} unread</span><button className="dl-button" disabled={operation.busy||Boolean(operation.reference)||!userId} onClick={()=>{setOperationDialog(true);void operation.prepare(item.id);}}>Mark {count?.count??0} done</button></div>}
      <BundlePage section={item.id} enabled={enabled} refreshKey={token} renderRow={renderRow}/>
      <div className="dl-bundle-actions"><span className="dl-muted">{item.description}</span><button className="dl-button dl-subtle" onClick={()=>setRules(item.id)}>Bundle rules</button></div>
     </div>}</div>
    </section>;
   })}
  </section>}
  {!grouped&&operation.reference&&<BundleOperationContent operation={operation} onResults={showResults} onDismiss={dismiss}/>}
  {overview&&!overview.indexing&&!error&&<p className="dl-bundle-total">{overview.totalCount} conversations · {overview.unreadCount} unread</p>}
  {overview?.totalCount===0&&!overview.indexing&&!error&&!busy&&!operation.reference&&<div className="dl-empty"><h2>A little breathing room.</h2><p>Your inbox is clear. Enjoy the space.</p></div>}
  {rules&&<Dialog title={`${BUNDLE_DEFINITIONS.find(item=>item.id===rules)?.title} rules`} onClose={()=>setRules(null)}><BundleRules bundle={rules}/></Dialog>}
  {operationDialog&&operation.reference&&<BundleOperationDialog operation={operation} onClose={()=>setOperationDialog(false)} onResults={showResults} onDismiss={dismiss}/>}
 </div>;
}
