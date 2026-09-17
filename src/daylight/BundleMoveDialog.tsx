import * as React from 'react';
import type { ThreadSummary } from '../lib/threadSummary';
import { BUNDLE_DEFINITIONS, type BundleId } from '../lib/bundles';
import { postInbox } from '../lib/attachmentClient';
import { Dialog } from './Dialog';
export function BundleMoveDialog({row,onClose,onChanged,onRefresh}:{row:ThreadSummary;onClose:()=>void;onChanged:(message:string)=>void;onRefresh:()=>void}) {
 const [bundle,setBundle]=React.useState<BundleId|null>(row.bundle?.bundle??null);
 const [future,setFuture]=React.useState(false);const [replace,setReplace]=React.useState(false);
 const [error,setError]=React.useState('');const [pending,setPending]=React.useState(false);const [partial,setPartial]=React.useState(false);
 const lock=React.useRef(false);const sender=row.bundleSender;
 const conflict=error.includes('rule already exists');const changedSender=error.includes('sender changed')||error.includes('assignment changed');
 const save=async()=>{
  if(lock.current)return;lock.current=true;setPending(true);setError('');
  try {
   const result=await postInbox<{moved:boolean;ruleSaved?:boolean;ruleError?:string}>('bundles/move',{threadId:row.threadId,bundle,...(future?{saveSenderRule:true,expectedSender:sender,...(replace?{replaceRule:true}:{})}:{})});
   if(result.ruleSaved===false){setPartial(true);setError(result.ruleError??'Conversation moved, but the future sender rule was not saved.');onChanged('');}
   else {onChanged(`Conversation moved to ${BUNDLE_DEFINITIONS.find(item=>item.id===bundle)?.title??'Conversations'}.${future?' Future mail from this exact sender will follow your rule.':''}`);onClose();}
  }catch(caught){setError(caught instanceof Error?caught.message:'Could not move this conversation.');}
  finally{lock.current=false;setPending(false);}
 };
 return <Dialog title="Move conversation" onClose={()=>{if(!lock.current)onClose();}}>
  <div className="dl-bundle-dialog">
   <p className="dl-muted">Currently in {BUNDLE_DEFINITIONS.find(item=>item.id===row.bundle?.bundle)?.title??'Conversations'} · {row.bundle?.source==='manual'?'Your conversation choice':row.bundle?.source==='sender'?`Exact sender rule: ${row.bundle.sender}`:row.bundle?.source==='builtin'?'Built-in matching':'No bundle match'}</p>
   <fieldset disabled={pending}><legend>Choose a bundle</legend><div className="dl-bundle-destinations">{[...BUNDLE_DEFINITIONS,{id:null,title:'No bundle'}].map(item=><button type="button" key={item.id??'none'} className="dl-button" aria-pressed={bundle===item.id} onClick={()=>setBundle(item.id)}>{item.title}</button>)}</div></fieldset>
   <label className="dl-checkbox-label"><input name="future" type="checkbox" checked={future} disabled={pending||!sender} onChange={event=>{setFuture(event.target.checked);setReplace(false);if(!event.target.checked&&conflict)setError('');}}/>Also move future mail from this exact sender</label>
   <p className="dl-bundle-address">{sender??'No single incoming sender is available for a rule.'}</p>
   <p className="dl-muted">Only this conversation moves unless you turn this on. Existing mail from this sender stays where it is. Pins always remain in Conversations.</p>
   {error&&<p role="alert">{error}</p>}
   {conflict&&future&&<label className="dl-checkbox-label"><input type="checkbox" checked={replace} disabled={pending} onChange={event=>setReplace(event.target.checked)}/>Replace the existing sender rule</label>}
   {changedSender&&<button type="button" className="dl-button" onClick={()=>{onRefresh();onClose();}}>Refresh and review conversation</button>}
   <div className="dl-confirm-actions"><button type="button" className="dl-button dl-subtle" disabled={pending} onClick={onClose}>{partial?'Keep conversation move':'Cancel'}</button><button type="button" className="dl-button dl-primary" disabled={pending||changedSender||(future&&conflict&&!replace)} onClick={()=>void save()}>{pending?'Moving…':partial?'Retry sender rule':'Move conversation'}</button></div>
  </div>
 </Dialog>;
}
