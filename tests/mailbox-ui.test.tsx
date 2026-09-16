// @vitest-environment jsdom
import * as React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {pages} from '../src/admin';
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
