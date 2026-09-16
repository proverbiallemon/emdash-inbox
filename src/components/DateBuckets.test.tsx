// @vitest-environment jsdom
import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it} from 'vitest';
import {DateBuckets} from './DateBuckets';
it('keeps an old pinned conversation above newer date buckets',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const container=document.createElement('div');const root=createRoot(container);
 await React.act(async()=>root.render(<DateBuckets rows={[{id:'pinned',sortAt:'2026-01-01T00:00:00Z',snoozeUntil:null,pinned:true},{id:'today',sortAt:'2026-09-16T10:00:00Z',snoozeUntil:null,pinned:false}]} field="sortAt" direction="past" now={new Date('2026-09-16T12:00:00Z')} renderRow={row=><p key={row.id}>{row.id}</p>}/>));
 expect([...container.querySelectorAll('p')].map(p=>p.textContent)).toEqual(['pinned','today']);
 await React.act(async()=>root.unmount());
});
