// @vitest-environment jsdom
import * as React from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {BundleMoveDialog} from '../src/daylight/BundleMoveDialog';
import {BundleInbox} from '../src/daylight/BundleInbox';
import {BundleSettingsDialog} from '../src/daylight/BundleSettingsDialog';
import {BUNDLE_IDS} from '../src/lib/bundles';
let root:Root;let container:HTMLDivElement;
const row:any={id:'one',threadId:'one',openMessageId:'one',bundle:{bundle:'orders',source:'builtin'},bundleSender:'receipts@example.com',latest:{subject:'Order fixture'}};
const response=(data:unknown)=>new Response(JSON.stringify({success:true,data}),{headers:{'Content-Type':'application/json'}});
async function act(fn:()=>void){await React.act(async()=>{fn();await new Promise(r=>setTimeout(r,0));});}
function button(text:string){const b=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);expect(b).toBeDefined();return b!;}
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;container=document.createElement('div');document.body.append(container);root=createRoot(container);localStorage.clear();Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(){this.open=true;}});Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(){this.open=false;}});});
afterEach(async()=>{await act(()=>root.unmount());container.remove();vi.unstubAllGlobals();});
it('discloses multiple groups without reading and gets the same Inbox ungrouped',async()=>{
 const calls:any[]=[];vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{const body=JSON.parse(init.body as string);calls.push([url,body]);return response(url.endsWith('overview')?{totalCount:12,unreadCount:7,bundles:BUNDLE_IDS.map(id=>({id,count:2,unreadCount:1,senders:['shop@example.com']}))}:{items:[{...row,id:body.section}],hasMore:false});});
 await act(()=>root.render(<BundleInbox userId="user" enabled={[...BUNDLE_IDS]} defaultGrouped refreshKey={0} renderRow={r=><p key={r.id}>{r.id} fixture</p>} onManage={()=>{}} onResults={()=>{}} />));
 const disclose=(name:string)=>container.querySelector<HTMLButtonElement>(`[aria-label^="Expand ${name} bundle,"]`)!;
 await act(()=>disclose('Orders').click());await act(()=>disclose('Shipping').click());expect(container.querySelectorAll('[aria-expanded="true"]')).toHaveLength(2);expect(calls.some(c=>c[0].endsWith('messages/thread'))).toBe(false);
 expect(container.textContent).toContain('12 conversations · 7 unread');await act(()=>button('All conversations').click());expect(calls.at(-1)[1]).toMatchObject({section:'conversations',enabled:[]});await act(()=>button('Bundled inbox').click());expect(container.querySelectorAll('[aria-expanded="true"]')).toHaveLength(2);
});
it('defaults to conversation-only and keeps consent and destination after conflict, with a synchronous save lock',async()=>{
 let finish!:(v:Response)=>void;const calls:any[]=[];vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{calls.push(JSON.parse(init.body as string));return new Promise< Response>(r=>finish=r);});
 const changed=vi.fn();await act(()=>root.render(<BundleMoveDialog row={row} onClose={()=>{}} onChanged={changed} onRefresh={()=>{}} />));
 expect(container.querySelector<HTMLInputElement>('[name="future"]')?.checked).toBe(false);
 await act(()=>button('Shipping').click());await act(()=>container.querySelector<HTMLInputElement>('[name="future"]')!.click());
 await act(()=>{button('Move conversation').click();button('Move conversation').click();});expect(calls).toHaveLength(1);expect(calls[0]).toEqual({threadId:'one',bundle:'shipping',saveSenderRule:true,expectedSender:'receipts@example.com'});
 await act(()=>finish(new Response(JSON.stringify({error:{message:'A rule already exists for this sender; explicitly replace it to continue'}}),{status:409})));
 expect(container.querySelector<HTMLInputElement>('[name="future"]')!.checked).toBe(true);expect(button('Shipping').getAttribute('aria-pressed')).toBe('true');expect(container.textContent).toContain('Replace the existing sender rule');expect(changed).not.toHaveBeenCalled();
});
it('preserves layout and selected bundle settings on failed save',async()=>{
 const update=vi.fn().mockResolvedValue(false);const close=vi.fn();const ui:any={preferences:{navigation:'left',fullWindow:true,enabledBundles:[...BUNDLE_IDS],bundledInbox:true},update,error:'Save failed'};
 await act(()=>root.render(<BundleSettingsDialog ui={ui} onClose={close}/>));await act(()=>container.querySelector<HTMLInputElement>('[name="orders"]')!.click());await act(()=>button('Save bundle settings').click());
 expect(update).toHaveBeenCalledWith({navigation:'left',fullWindow:true,enabledBundles:BUNDLE_IDS.filter(id=>id!=='orders'),bundledInbox:true});expect(close).not.toHaveBeenCalled();expect(container.querySelector<HTMLInputElement>('[name="orders"]')!.checked).toBe(false);
});
it('reports a partial rule save without closing or clearing chosen inputs',async()=>{
 vi.stubGlobal('fetch',async()=>response({moved:true,ruleSaved:false,ruleError:'Conversation moved, but rule storage failed.'}));const close=vi.fn();const changed=vi.fn();
 await act(()=>root.render(<BundleMoveDialog row={row} onClose={close} onChanged={changed} onRefresh={()=>{}}/>));await act(()=>button('Fans').click());await act(()=>container.querySelector<HTMLInputElement>('[name="future"]')!.click());await act(()=>button('Move conversation').click());
 expect(close).not.toHaveBeenCalled();expect(button('Fans').getAttribute('aria-pressed')).toBe('true');expect(container.querySelector('[role="alert"]')?.textContent).toContain('Conversation moved');expect(changed).toHaveBeenCalledTimes(1);expect(button('Retry sender rule')).toBeDefined();
});
it('does not offer rule replacement when the consented sender changed',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({error:{message:'The latest incoming sender changed; review the sender before saving a rule'}}),{status:409}));
 await act(()=>root.render(<BundleMoveDialog row={row} onClose={()=>{}} onChanged={()=>{}} onRefresh={()=>{}}/>));await act(()=>container.querySelector<HTMLInputElement>('[name="future"]')!.click());await act(()=>button('Move conversation').click());
 expect(button('Refresh and review conversation')).toBeDefined();expect(button('Move conversation').disabled).toBe(true);expect(container.textContent).not.toContain('Replace the existing sender rule');
});
it('distinguishes disabled groups, indexing and overview errors from an empty Inbox',async()=>{
 let mode='normal';vi.stubGlobal('fetch',async(url:string)=>url.endsWith('overview')?mode==='error'?new Response(JSON.stringify({error:{message:'Overview failed'}}),{status:503}):response({totalCount:mode==='indexing'?0:1,unreadCount:0,indexing:mode==='indexing',bundles:[]}):response({items:[],hasMore:false}));
 const view=(refreshKey:number)=><BundleInbox userId="user" enabled={[]} defaultGrouped refreshKey={refreshKey} renderRow={()=>null} onManage={()=>{}} onResults={()=>{}}/>;
 await act(()=>root.render(view(0)));expect(container.textContent).toContain('All bundles are turned off');expect(container.textContent).not.toContain('Your inbox is clear');
 mode='indexing';await act(()=>root.render(view(1)));expect(container.textContent).toContain('Updating the mailbox index');expect(container.textContent).not.toContain('Your inbox is clear');
 mode='error';await act(()=>root.render(view(2)));expect(container.textContent).toContain('Overview failed');expect(container.textContent).not.toContain('Your inbox is clear');
});
it('restores a durable operation by checking status without resending a mutation',async()=>{
 const reference={bundle:'orders',requestId:'saved-request',operationId:'server-opaque',unknown:true};localStorage.setItem('daylight:bundle-operation:v1:user',JSON.stringify(reference));const calls:string[]=[];
 vi.stubGlobal('fetch',async(url:string)=>{calls.push(url);if(url.endsWith('done-status'))return response({id:'server-opaque',bundle:'orders',phase:'running',total:3,unreadCount:2,counts:{done:2,pending:1,failed:0,skipped:0},retryable:false});return response(url.endsWith('overview')?{totalCount:1,unreadCount:0,bundles:[]}:{items:[],hasMore:false});});
 await act(()=>root.render(<BundleInbox userId="user" enabled={[...BUNDLE_IDS]} defaultGrouped refreshKey={0} renderRow={()=>null} onManage={()=>{}} onResults={()=>{}}/>));
 expect(calls.filter(url=>url.endsWith('done-status'))).toHaveLength(1);expect(calls.some(url=>url.endsWith('done-run'))).toBe(false);expect(button('Continue operation')).toBeDefined();
});
it('keeps pagination independent and ignores a late page after changing presentation',async()=>{
 let finish!:(response:Response)=>void;const calls:any[]=[];
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{const body=JSON.parse(init.body as string);calls.push(body);if(url.endsWith('overview'))return response({totalCount:9,unreadCount:2,bundles:[{id:'orders',count:3,unreadCount:1,senders:[]},{id:'shipping',count:3,unreadCount:1,senders:[]}]});if(body.cursor)return new Promise<Response>(r=>finish=r);return response({items:[{...row,id:body.section}],hasMore:body.section==='orders',cursor:'orders-next'});});
 await act(()=>root.render(<BundleInbox userId="user" enabled={[...BUNDLE_IDS]} defaultGrouped refreshKey={0} renderRow={r=><p key={r.id}>{r.id}</p>} onManage={()=>{}} onResults={()=>{}}/>));
 await act(()=>container.querySelector<HTMLButtonElement>('[aria-label^="Expand Orders bundle"]')!.click());await act(()=>container.querySelector<HTMLButtonElement>('[aria-label^="Expand Shipping bundle"]')!.click());await act(()=>button('Load more orders').click());
 expect(calls.at(-1)).toMatchObject({section:'orders',cursor:'orders-next'});await act(()=>button('All conversations').click());await act(()=>finish(response({items:[{...row,id:'obsolete'}],hasMore:false})));expect(container.textContent).not.toContain('obsolete');
});
it('focuses the bundle header after a focused row disappears on refresh',async()=>{
 let hasRow=true;vi.stubGlobal('fetch',async(url:string)=>response(url.endsWith('overview')?{totalCount:2,unreadCount:1,bundles:[{id:'orders',count:2,unreadCount:1,senders:[]}]}:{items:hasRow?[row]:[],hasMore:false}));
 const view=(refreshKey:number)=><BundleInbox userId="user" enabled={[...BUNDLE_IDS]} defaultGrouped refreshKey={refreshKey} renderRow={r=><button key={r.id}>Row control</button>} onManage={()=>{}} onResults={()=>{}}/>;
 await act(()=>root.render(view(0)));await act(()=>container.querySelector<HTMLButtonElement>('[aria-label^="Expand Orders bundle"]')!.click());const control=container.querySelector<HTMLButtonElement>('.dl-bundle-body .dl-bundle-page button')!;control.focus();hasRow=false;await act(()=>root.render(view(1)));expect(document.activeElement?.getAttribute('aria-label')).toContain('Collapse Orders bundle');
});
it('retains two expanded groups through reading, return, view toggles and global search',async()=>{
 const {pages}=await import('../src/admin');window.history.replaceState({},'','/');const date='2026-09-17T10:00:00Z';let read=false;const calls:string[]=[];
 const summary=(id:string):any=>({...row,id,threadId:id,openMessageId:id,latest:{messageId:id,threadId:id,subject:id,from:'reader@example.com',to:'owner@example.com',direction:'inbound',status:'inbox',bodyText:'Fixture body',bodyHtml:null,receivedAt:date,sortAt:date,snoozeUntil:null,read:false,pinned:false},previous:null,participants:[],messageCount:1,unreadCount:read?0:1,pinned:false,sortAt:date,snoozeUntil:null});
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{calls.push(url);const body=JSON.parse(init.body as string);if(url.endsWith('ui/preferences'))return response({preferences:{navigation:'top',fullWindow:false,enabledBundles:[...BUNDLE_IDS],bundledInbox:true},userId:'user',canSave:true});if(url.endsWith('overview'))return response({totalCount:4,unreadCount:read?1:2,bundles:[{id:'orders',count:2,unreadCount:read?0:1,senders:[]},{id:'shipping',count:2,unreadCount:1,senders:[]}]});if(url.endsWith('messages/thread')){read=true;return response({items:[{id:body.id,data:summary(body.id).latest}]});}if(url.endsWith('messages/search'))return response({items:[],hasMore:false});return response({items:body.section==='conversations'?[]:[summary(body.section??'ordinary')],hasMore:false});});
 await act(()=>root.render(React.createElement(pages['/'] as React.ComponentType)));await act(()=>container.querySelector<HTMLButtonElement>('[aria-label^="Expand Orders bundle"]')!.click());await act(()=>container.querySelector<HTMLButtonElement>('[aria-label^="Expand Shipping bundle"]')!.click());await act(()=>container.querySelector<HTMLButtonElement>('[aria-label="Open orders"]')!.click());
 expect(container.querySelectorAll('.dl-bundle-heading[aria-expanded="true"]')).toHaveLength(2);expect(container.textContent).toContain('4 conversations · 1 unread');
 const back=[...container.querySelectorAll('button')].find(b=>b.textContent?.includes('← Inbox')&&b.closest('.dl-detail'))!;await act(()=>back.click());await act(()=>button('All conversations').click());await act(()=>button('Bundled inbox').click());expect(container.querySelectorAll('.dl-bundle-heading[aria-expanded="true"]')).toHaveLength(2);
 const input=container.querySelector<HTMLInputElement>('[aria-label="Search your mail"]')!;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;await act(()=>{setter.call(input,'needle');input.dispatchEvent(new Event('input',{bubbles:true}));});await act(()=>input.closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(calls.some(url=>url.endsWith('messages/search'))).toBe(true);expect(container.querySelector('.dl-bundle-inbox')).toBeNull();expect(window.location.search).toContain('status=all');
});
it('waits for a prepared snapshot, confirms once, retries only failed remainder and focuses the result',async()=>{
 let prepared!:(response:Response)=>void;let executed!:(response:Response)=>void;const calls:any[]=[];const result=vi.fn();const base={id:'opaque-operation',bundle:'orders',total:3,unreadCount:2,counts:{pending:3,done:0,skipped:0,failed:0},retryable:false};
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{const body=JSON.parse(init.body as string);calls.push([url,body]);if(url.endsWith('done-prepare'))return new Promise<Response>(r=>prepared=r);if(url.endsWith('done-run'))return body.retry?response({...base,phase:'complete',counts:{pending:0,done:3,skipped:0,failed:0}}):new Promise<Response>(r=>executed=r);return response(url.endsWith('overview')?{totalCount:3,unreadCount:2,bundles:[{id:'orders',count:3,unreadCount:2,senders:[]}]}:{items:[],hasMore:false});});
 await act(()=>root.render(<BundleInbox userId="user" enabled={[...BUNDLE_IDS]} defaultGrouped refreshKey={0} renderRow={()=>null} onManage={()=>{}} onResults={result}/>));await act(()=>container.querySelector<HTMLButtonElement>('[aria-label^="Expand Orders bundle"]')!.click());await act(()=>button('Mark 3 done').click());expect(container.querySelector('dialog')?.textContent).toContain('Preparing a fixed snapshot');expect(calls.some(c=>c[0].endsWith('done-run'))).toBe(false);
 await act(()=>prepared(response({...base,phase:'ready'})));const confirm=[...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Confirm 3 conversations done')!;await act(()=>{confirm.click();confirm.click();});expect(calls.filter(c=>c[0].endsWith('done-run'))).toHaveLength(1);
 await act(()=>executed(response({...base,phase:'complete',retryable:true,counts:{pending:0,done:2,skipped:0,failed:1}})));expect(document.activeElement).toBe(container.querySelector('dialog .dl-bundle-operation'));expect(container.querySelector('dialog')?.textContent).toContain('2 done. 1 still needs attention.');
 const retry=[...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Retry failed remainder')!;await act(()=>retry.click());expect(calls.filter(c=>c[0].endsWith('done-run')).at(-1)[1]).toEqual({operationId:'opaque-operation',retry:true});expect(container.querySelector('dialog')?.textContent).toContain('3 done.');
 await act(()=>[...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='View conversations in Done')!.click());expect(result).toHaveBeenCalledWith('opaque-operation');
});
it('waits for saved preferences before opening the settings deep link',async()=>{
 const {pages}=await import('../src/admin');window.history.replaceState({},'','/?settings=bundles');let finish!:(r:Response)=>void;
 vi.stubGlobal('fetch',async(url:string)=>url.endsWith('ui/preferences')?new Promise<Response>(r=>finish=r):response(url.endsWith('overview')?{totalCount:0,unreadCount:0,bundles:[]}:{items:[],hasMore:false}));
 await act(()=>root.render(React.createElement(pages['/'] as React.ComponentType)));expect(container.querySelector('dialog')).toBeNull();
 await act(()=>finish(response({preferences:{navigation:'left',fullWindow:false,enabledBundles:['shipping'],bundledInbox:false},userId:'user',canSave:true})));expect(container.querySelector<HTMLInputElement>('[name="orders"]')!.checked).toBe(false);expect(container.querySelector<HTMLInputElement>('[name="shipping"]')!.checked).toBe(true);window.history.replaceState({},'','/');
});
it('shows existing action failures in the grouped Inbox',async()=>{
 const {pages}=await import('../src/admin');window.history.replaceState({},'','/');const item:any={...row,pinned:false,participants:[],sortAt:'2026-09-17T10:00:00Z',snoozeUntil:null,messageCount:1,unreadCount:1,latest:{...row.latest,from:'mara@example.com',bodyText:'Fixture',status:'inbox'}};
 vi.stubGlobal('fetch',async(url:string)=>url.endsWith('ui/preferences')?response({preferences:{navigation:'top',fullWindow:false,enabledBundles:[...BUNDLE_IDS],bundledInbox:true},userId:'user',canSave:true}):url.endsWith('threads/action')?new Response(JSON.stringify({error:{message:'Unable to update conversation'}}),{status:503}):response(url.endsWith('overview')?{totalCount:1,unreadCount:1,bundles:[]}:{items:[item],hasMore:false}));
 await act(()=>root.render(React.createElement(pages['/'] as React.ComponentType)));await act(()=>container.querySelector<HTMLButtonElement>('[title="Mark done"]')!.click());expect(container.querySelector('[role="alert"]')?.textContent).toContain('Unable to update conversation');
});
it('recovers from a sender-rule conflict by submitting the chosen destination for this conversation only',async()=>{
 const writes:any[]=[];const close=vi.fn();
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{
  writes.push(JSON.parse(init.body as string));
  return writes.length===1?new Response(JSON.stringify({error:{message:'A rule already exists for this sender; explicitly replace it to continue'}}),{status:409}):response({moved:true});
 });
 await act(()=>root.render(<BundleMoveDialog row={row} onClose={close} onChanged={()=>{}} onRefresh={()=>{}}/>));
 await act(()=>button('Shipping').click());await act(()=>container.querySelector<HTMLInputElement>('[name="future"]')!.click());await act(()=>button('Move conversation').click());
 expect(button('Move conversation').disabled).toBe(true);
 await act(()=>container.querySelector<HTMLInputElement>('[name="future"]')!.click());
 expect(button('Shipping').getAttribute('aria-pressed')).toBe('true');expect(button('Move conversation').disabled).toBe(false);expect(container.querySelector('[role="alert"]')).toBeNull();
 await act(()=>button('Move conversation').click());
 expect(writes[1]).toEqual({threadId:'one',bundle:'shipping'});expect(close).toHaveBeenCalledTimes(1);
});
it('refreshes terminal operation summaries after status changes, reading and correction',async()=>{
 const {pages}=await import('../src/admin');window.history.replaceState({},'','/?status=done&operation=operation-results');
 const date='2026-09-17T10:00:00Z';let folder='inbox';let read=false;let assignment='orders';let resultReads=0;
 const summary=():any=>({...row,bundle:{bundle:assignment,source:'manual'},latest:{messageId:'one',threadId:'one',subject:'Affected conversation',from:'reader@example.com',to:'owner@example.com',direction:'inbound',status:folder,bodyText:'Fixture body',bodyHtml:null,receivedAt:date,sortAt:date,snoozeUntil:null,read,pinned:false},previous:null,participants:[],messageCount:1,unreadCount:read?0:1,pinned:false,sortAt:date,snoozeUntil:null});
 vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{callback(0);return 0;});
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
  const body=JSON.parse(init.body as string);
  if(url.endsWith('ui/preferences'))return response({preferences:{navigation:'top',fullWindow:false,enabledBundles:[...BUNDLE_IDS],bundledInbox:true},userId:'user',canSave:true});
  if(url.endsWith('bundles/done-threads')){resultReads++;return response({items:[{threadId:'one',openMessageId:'one',outcome:'done',summary:summary()}],hasMore:false});}
  if(url.endsWith('threads/action')){folder=body.status;return response({updated:1});}
  if(url.endsWith('messages/thread')){read=true;return response({items:[{id:'one',data:summary().latest}]});}
  if(url.endsWith('bundles/move')){assignment=body.bundle;return response({moved:true});}
  return response({items:[],hasMore:false});
 });
 await act(()=>root.render(React.createElement(pages['/'] as React.ComponentType)));
 const results=()=>container.querySelector('.dl-bundle-results')!;
 expect(results().textContent).toContain('Marked done · Currently inbox');expect(results().querySelector('.dl-thread-card')?.getAttribute('data-read')).toBe('false');
 await act(()=>results().querySelector<HTMLButtonElement>('[title="Mark done"]')!.click());
 expect(results().textContent).toContain('Marked done · Currently done');
 await act(()=>results().querySelector<HTMLButtonElement>('[aria-label="Open Affected conversation"]')!.click());
 await act(()=>[...container.querySelectorAll<HTMLButtonElement>('.dl-detail button')].find(b=>b.textContent?.includes('← Inbox'))!.click());
 expect(results().querySelector('.dl-thread-card')?.getAttribute('data-read')).toBe('true');expect(results().textContent).toContain('Marked done');
 const beforeCorrection=resultReads;
 await act(()=>results().querySelector<HTMLButtonElement>('[title="Move conversation"]')!.click());await act(()=>button('Shipping').click());await act(()=>button('Move conversation').click());
 expect(resultReads).toBeGreaterThan(beforeCorrection);
 await act(()=>results().querySelector<HTMLButtonElement>('[title="Move conversation"]')!.click());expect(container.querySelector('dialog')?.textContent).toContain('Currently in Shipping');
 window.history.replaceState({},'','/');
});
it('invalidates pending operation-result pagination when refreshed summaries arrive',async()=>{
 const {BundleResults}=await import('../src/daylight/BundleResults');let finish!:(value:Response)=>void;let refreshed=false;
 const result=(id:string,status:string)=>({threadId:id,openMessageId:id,outcome:'done',summary:{...row,id,threadId:id,latest:{...row.latest,status}}});
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{const body=JSON.parse(init.body as string);if(body.cursor)return new Promise<Response>(r=>finish=r);return response({items:[result('first',refreshed?'snoozed':'done')],hasMore:!refreshed,...(!refreshed?{cursor:'next-page'}:{})});});
 const view=(refreshKey:number)=><BundleResults operationId="operation-results" refreshKey={refreshKey} renderRow={summary=><p key={summary.id}>{summary.id}</p>} onBack={()=>{}}/>;
 await act(()=>root.render(view(0)));await act(()=>button('Load more results').click());refreshed=true;await act(()=>root.render(view(1)));
 expect(container.textContent).toContain('Currently snoozed');
 await act(()=>finish(response({items:[result('obsolete','done')],hasMore:true,cursor:'stale-page'})));
 expect(container.textContent).not.toContain('obsolete');expect(container.textContent).not.toContain('Load more results');expect(container.textContent).toContain('Marked done · Currently snoozed');
});
