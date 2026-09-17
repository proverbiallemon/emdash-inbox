import * as React from 'react';
import { BUNDLE_DEFINITIONS, type BundleRule } from '../lib/bundles';
import { postInbox } from '../lib/attachmentClient';
import type { useInboxPreferences } from './preferences';
import { Dialog } from './Dialog';
export function BundleRules({bundle}:{bundle?:string}) {
 const [data,setData]=React.useState<{rules:BundleRule[];explanation:string}|null>(null);const [error,setError]=React.useState('');const [revision,setRevision]=React.useState(0);
 React.useEffect(()=>{let active=true;setError('');postInbox<{rules:BundleRule[];explanation:string}>('bundles/rules',{}).then(value=>{if(active)setData(value);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[revision]);
 return <div className="dl-bundle-rules">{error?<><p role="alert">{error}</p><button className="dl-button" onClick={()=>setRevision(v=>v+1)}>Retry rules</button></>:!data?<p role="status">Loading sender rules…</p>:<><p>{data.explanation}</p><p className="dl-muted">Manually excluded conversations stay outside bundles. Pinned mail is always shown in Conversations. Rules match an exact sender address, never an entire domain.</p>{data.rules.filter(rule=>!bundle||rule.bundle===bundle).map(rule=><p key={rule.id} className="dl-bundle-rule"><span>{rule.sender}</span><strong>{BUNDLE_DEFINITIONS.find(item=>item.id===rule.bundle)?.title??'No bundle'}</strong></p>)}{!data.rules.length&&<p className="dl-muted">No saved sender rules.</p>}</>}</div>;
}
export function BundleSettingsDialog({ui,onClose}:{ui:ReturnType<typeof useInboxPreferences>;onClose:()=>void}) {
 const [enabled,setEnabled]=React.useState(ui.preferences.enabledBundles);const [grouped,setGrouped]=React.useState(ui.preferences.bundledInbox);const [rules,setRules]=React.useState(false);const lock=React.useRef(false);
 const save=async()=>{if(lock.current)return;lock.current=true;try{if(await ui.update({...ui.preferences,enabledBundles:enabled,bundledInbox:grouped}))onClose();}finally{lock.current=false;}};
 return <Dialog title="Manage bundles" onClose={()=>{if(!lock.current)onClose();}}><div className="dl-bundle-dialog">
  <p className="dl-muted">Choose what groups in your Inbox. Turning a bundle off shows its mail as individual conversations.</p>
  <div className="dl-bundle-settings">{BUNDLE_DEFINITIONS.map(item=><label key={item.id}><span>{item.title}</span><input type="checkbox" name={item.id} checked={enabled.includes(item.id)} disabled={ui.saving} onChange={event=>setEnabled(current=>event.target.checked?[...current,item.id]:current.filter(id=>id!==item.id))}/></label>)}</div>
  <label className="dl-checkbox-label"><input type="checkbox" checked={grouped} disabled={ui.saving} onChange={event=>setGrouped(event.target.checked)}/>Use Bundled inbox by default</label>
  <button className="dl-button dl-subtle" type="button" aria-expanded={rules} onClick={()=>setRules(value=>!value)}>How grouping works</button>
  {rules?<BundleRules/>:<p className="dl-muted">Sender rules match exact addresses. Manually excluded mail and pins stay in Conversations.</p>}
  {ui.error&&<p role="alert">{ui.error}</p>}
  <button className="dl-button dl-primary" type="button" disabled={ui.loading||ui.saving} onClick={()=>void save()}>{ui.saving?'Saving…':'Save bundle settings'}</button>
 </div></Dialog>;
}
