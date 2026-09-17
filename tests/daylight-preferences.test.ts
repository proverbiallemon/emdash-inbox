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

it("defaults old accounts to bundles and preserves both settings groups independently",async()=>{
 const {ctx,store}=context("owner");
 store.set("ui:owner",{navigation:"left",fullWindow:true});
 expect((await readInboxPreferences(ctx as any)).preferences).toMatchObject({enabledBundles:["orders","shipping","commissions","fans","promos","updates"],bundledInbox:true});
 await saveInboxPreferences({...ctx,input:{enabledBundles:["shipping"],bundledInbox:false}} as any);
 expect((await readInboxPreferences(ctx as any)).preferences).toEqual({navigation:"left",fullWindow:true,enabledBundles:["shipping"],bundledInbox:false});
 await saveInboxPreferences({...ctx,input:{navigation:"top",fullWindow:false}} as any);
 expect((await readInboxPreferences(ctx as any)).preferences).toEqual({navigation:"top",fullWindow:false,enabledBundles:["shipping"],bundledInbox:false});
 for(const enabledBundles of [["unknown"],["orders","orders"],"orders"]) await expect(saveInboxPreferences({...ctx,input:{enabledBundles}} as any)).rejects.toThrow();
});
it("maps primitive settings bodies to useful validation errors",async()=>{
 const {ctx}=context("owner");
 for(const input of ["bad",7,true,[]])await expect(saveInboxPreferences({...ctx,input} as any)).rejects.toMatchObject({status:400});
});
it("returns the authenticated account identifier for scoping local operation recovery",async()=>{
 expect(await readInboxPreferences(context("account-one").ctx as any)).toMatchObject({userId:"account-one"});
 expect(await readInboxPreferences(context().ctx as any)).toMatchObject({userId:null});
});
