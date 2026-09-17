// @vitest-environment node
import { expect, it } from "vitest";
import { readInboxPreferences, saveInboxPreferences } from "../src/lib/uiPreferences";
function context(id?: string) {
 const store = new Map<string, unknown>();
 return { store, ctx: { user: id ? {id,name:"Alex"} : undefined, kv: {get:async(key:string)=>store.get(key),set:async(key:string,value:unknown)=>{store.set(key,value);}} } };
}
it("stores appearance by authenticated account and ignores body identity",async()=>{
 const {ctx,store}=context("owner/a");
 await saveInboxPreferences({...ctx,input:{navigation:"left",fullWindow:true,userId:"someone-else"}} as any);
 expect([...store.keys()]).toEqual(["ui:owner%2Fa"]);
 expect(await readInboxPreferences(ctx as any)).toMatchObject({preferences:{navigation:"left",fullWindow:true},canSave:true,name:"Alex"});
 expect(await readInboxPreferences({...ctx,user:{id:"second"}} as any)).toMatchObject({preferences:{navigation:"top",fullWindow:false}});
});
it("rejects token-only saves and malformed settings without writing",async()=>{
 const {ctx,store}=context();
 expect(await readInboxPreferences(ctx as any)).toMatchObject({canSave:false});
 await expect(saveInboxPreferences({...ctx,input:{navigation:"left",fullWindow:true}} as any)).rejects.toThrow("Sign in");
 const authenticated={...ctx,user:{id:"owner"}};
 for(const input of [null,{}, {navigation:"bottom",fullWindow:true},{navigation:"left",fullWindow:"yes"}]) {
  await expect(saveInboxPreferences({...authenticated,input} as any)).rejects.toThrow("Choose top");
 }
 expect(store.size).toBe(0);
});

