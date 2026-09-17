import * as React from 'react';
import { BUNDLE_DEFINITIONS } from '../lib/bundles';
import type { useBundleOperation } from './useBundleOperation';
import { Dialog } from './Dialog';
type Operation = ReturnType<typeof useBundleOperation>;
export function BundleOperationContent({operation,onResults,onDismiss}:{operation:Operation;onResults:(id:string)=>void;onDismiss:()=>void}) {
 const content=React.useRef<HTMLDivElement>(null);
 const {reference,busy,error}=operation;
 React.useLayoutEffect(()=>{if(reference?.view?.phase==='ready'||reference?.view?.phase==='complete'){if(content.current?.closest('dialog')||document.activeElement===document.body)content.current?.focus();}},[reference?.view?.phase]);
 if(!reference)return null;
 const view=reference.view;const title=BUNDLE_DEFINITIONS.find(item=>item.id===reference.bundle)?.title;
 return <div className="dl-bundle-operation" tabIndex={-1} ref={content}>
  {error&&<p role="alert">{error}</p>}
  {reference.unknown?<><p>We couldn’t confirm the last response. Check the saved operation before continuing.</p><button className="dl-button" disabled={busy} onClick={()=>void operation.reconcile()}>Check operation status</button></>:!view||view.phase==='preparing'?<><p role="status">Preparing a fixed snapshot of {title}… {view?`${view.total} conversations found.`:''}</p>{!busy&&<button className="dl-button" onClick={()=>void operation.resumePreparation()}>Continue preparing</button>}</>:view.phase==='ready'?<>
   <p><strong>{view.total} conversations · {view.unreadCount} unread</strong></p><p>Move this prepared set to Done? New arrivals, pinned mail and changed conversations are kept safe. Unread mail stays unread.</p>
   <div className="dl-confirm-actions"><button className="dl-button dl-subtle" disabled={busy} onClick={onDismiss}>Keep in Inbox</button><button className="dl-button dl-primary" disabled={busy} onClick={()=>void operation.run()}>Confirm {view.total} conversations done</button></div>
  </>:view.phase==='running'?<><p role="status">{view.counts.done} done. Working through the prepared conversations…</p>{!busy&&<button className="dl-button" onClick={()=>void operation.run()}>Continue operation</button>}</>:<>
   <p role="status"><strong>{view.counts.done} done. {view.counts.failed+view.counts.pending>0?`${view.counts.failed+view.counts.pending} still ${view.counts.failed+view.counts.pending===1?"needs":"need"} attention.`:view.counts.skipped>0?'The remaining conversations were kept unchanged.':'Prepared conversations are complete.'}</strong></p>
   {view.counts.skipped>0&&<p>{view.counts.skipped} changed conversations were kept as they are.</p>}
   <div className="dl-confirm-actions">{view.retryable&&<button className="dl-button dl-primary" disabled={busy} onClick={()=>void operation.run(true)}>Retry failed remainder</button>}<button className="dl-button" disabled={busy} onClick={()=>onResults(view.id)}>View conversations in Done</button><button className="dl-button dl-subtle" disabled={busy} onClick={onDismiss}>{view.retryable?'Keep remainder in Inbox':'Dismiss result'}</button></div>
  </>}
 </div>;
}
export function BundleOperationDialog({operation,onClose,onResults,onDismiss}:{operation:Operation;onClose:()=>void;onResults:(id:string)=>void;onDismiss:()=>void}) {
 return <Dialog title={`Mark ${BUNDLE_DEFINITIONS.find(item=>item.id===operation.reference?.bundle)?.title??'bundle'} done`} onClose={onClose}><BundleOperationContent operation={operation} onResults={onResults} onDismiss={onDismiss}/></Dialog>;
}
