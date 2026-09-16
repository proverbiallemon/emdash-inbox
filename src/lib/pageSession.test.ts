import { describe, expect, it } from 'vitest';
import { PageSession } from './pageSession';
describe('mailbox page session',()=>{
 it('rejects a previous tab response after a new request begins',()=>{
  const pages=new PageSession<{id:string;value:number}>();
  const old=pages.reset();const current=pages.reset();
  expect(pages.accept(current,[{id:'done',value:2}],false)).toEqual([{id:'done',value:2}]);
  expect(pages.accept(old,[{id:'inbox',value:1}],false)).toBeNull();
 });
 it('deduplicates moving threads while retaining updated data on load more',()=>{
  const pages=new PageSession<{id:string;value:number}>();const request=pages.reset();
  pages.accept(request,[{id:'a',value:1},{id:'b',value:1}],false);
  expect(pages.accept(request,[{id:'b',value:2},{id:'c',value:1}],true)).toEqual([{id:'a',value:1},{id:'b',value:2},{id:'c',value:1}]);
 });
});
