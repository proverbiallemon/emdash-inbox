// @vitest-environment jsdom
import * as React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {pages} from '../src/admin';
import {ThreadView} from '../src/components/ThreadView';
let container:HTMLDivElement;let root:Root;
function row(id:string,status='inbox') {return {id,threadId:id,openMessageId:id,latest:{messageId:id,threadId:id,subject:id,from:'reader@example.com',to:'owner@example.com',direction:'inbound',status,bodyText:'Fixture',bodyHtml:null,receivedAt:'2026-09-16T00:00:00Z',sortAt:'2026-09-16T00:00:00Z',snoozeUntil:null},previous:null,participants:[],messageCount:1,unreadCount:1,pinned:false,sortAt:'2026-09-16T00:00:00Z',snoozeUntil:null};}
function response(data:unknown) {return new Response(JSON.stringify({success:true,data}),{headers:{'Content-Type':'application/json'}});}
function deferred(){let resolve!:(v:Response)=>void;const promise=new Promise<Response>(r=>resolve=r);return {promise,resolve};}
async function flush(){await React.act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function click(text:string){const button=[...container.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);expect(button).toBeDefined();await React.act(async()=>button!.click());await flush();}
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;window.history.replaceState({},'','/');container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await React.act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
it('keeps the new tab when an action from the previous tab completes',async()=>{
 const action=deferred();const requested:string[]=[];
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
  if(url.endsWith('/ui/preferences'))return response({preferences:{navigation:'top',fullWindow:false},canSave:false});
  if(url.endsWith('/threads/action'))return action.promise;
  const {status}=JSON.parse(init.body as string);requested.push(status);return response({items:[row(status==='done'?'Done fixture':'Inbox fixture',status)],hasMore:false});
 });
 await React.act(async()=>root.render(React.createElement(pages['/'] as React.ComponentType)));await flush();
 await click('✓ Done');await click('Done');
 expect(container.textContent).toContain('Done fixture');
 await React.act(async()=>action.resolve(response({updated:1})));await flush();
 expect(container.textContent).toContain('Done fixture');expect(container.textContent).not.toContain('Inbox fixture');expect(requested).toEqual(['inbox','done']);
});
it('appends another complete page and ignores duplicate moving threads',async()=>{
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{
  const {cursor}=JSON.parse(init.body as string);
  return response(cursor?{items:[row('First fixture'),row('Second fixture')],hasMore:false}:{items:[row('First fixture')],cursor:'page2',hasMore:true});
 });
 await React.act(async()=>root.render(React.createElement(pages['/'] as React.ComponentType)));await flush();await click('Load more conversations');
 expect(container.textContent).toContain('Second fixture');expect(container.textContent?.split('First fixture')).toHaveLength(2);expect(container.textContent).not.toContain('Load more conversations');
});
it('continues an empty search scan and opens a later matching message',async()=>{
 window.history.replaceState({},'','/?status=all&q=needle');const requests:any[]=[];
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
  if(url.endsWith('/ui/preferences'))return response({preferences:{navigation:'top',fullWindow:false},canSave:false});
  if(url.endsWith('/messages/thread'))return response({items:[]});
  const body=JSON.parse(init.body as string);requests.push(body);
  return response(body.cursor?{items:[{id:'match',...row('Needle found').latest,read:false,pinned:false}],hasMore:false}:{items:[],cursor:'scan-next',hasMore:true});
 });
 await React.act(async()=>root.render(React.createElement(pages['/'] as React.ComponentType)));await flush();
 expect(container.textContent).toContain('Keep looking.');await click('Continue search');
 expect(requests).toEqual([{query:'needle',limit:25},{query:'needle',limit:25,cursor:'scan-next'}]);
 expect(container.textContent).toContain('Needle found');expect(container.textContent).not.toContain('Continue search');
 const open=container.querySelector<HTMLButtonElement>('[aria-label="Open Needle found"]')!;
 await React.act(async()=>open.click());await flush();expect(window.location.search).toContain('message=match');
});
it('ignores a late search result after returning to Inbox',async()=>{
 window.history.replaceState({},'','/?status=all&q=needle');const search=deferred();
 vi.stubGlobal('fetch',async(url:string)=>url.endsWith('/ui/preferences')?response({preferences:{navigation:'top',fullWindow:false},canSave:false}):url.endsWith('/messages/search')?search.promise:response({items:[row('Inbox stays')],hasMore:false}));
 await React.act(async()=>root.render(React.createElement(pages['/'] as React.ComponentType)));await flush();await click('Inbox');
 await React.act(async()=>search.resolve(response({items:[{id:'late',...row('Late match').latest}],hasMore:false})));await flush();
 expect(container.textContent).toContain('Inbox stays');expect(container.textContent).not.toContain('Late match');
});

it('reveals the older message selected by a search result',async()=>{
 vi.stubGlobal('fetch',async()=>response({items:[
  {id:'historical-hit',data:{...row('Historical subject').latest,bodyText:'Needle in the earlier message'}},
  {id:'latest',data:{...row('Latest subject').latest,bodyText:'A later reply without the search term'}}
 ]}));
 await React.act(async()=>root.render(<ThreadView messageId="historical-hit" debug={false} onBack={()=>{}}/>));await flush();
 const history=container.querySelector<HTMLDetailsElement>('.dl-history');
 expect(history?.open).toBe(true);expect(history?.textContent).toContain('Needle in the earlier message');
});
