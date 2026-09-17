import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DaylightShell } from "../src/daylight/Shell";
import { NavigationProvider, useLeaveGuard, useMailNavigation } from "../src/daylight/navigation";
import { useInboxPreferences } from "../src/daylight/preferences";
let container:HTMLDivElement;let root:Root;
function response(data:unknown) {return new Response(JSON.stringify({success:true,data}),{headers:{"Content-Type":"application/json"}});}
async function act(action:()=>void) {await React.act(async()=>{action();});}
function button(text:string) {return [...document.querySelectorAll<HTMLButtonElement>("button")].find(node=>node.textContent?.trim()===text)!;}
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(){this.open=false;}});
 vi.spyOn(HTMLDialogElement.prototype,"showModal" as any).mockImplementation(function(this:HTMLDialogElement){this.open=true;});
 vi.spyOn(HTMLDialogElement.prototype,"close" as any).mockImplementation(function(this:HTMLDialogElement){this.open=false;});
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
function Harness(){
 const ui=useInboxPreferences();
 return <DaylightShell ui={ui} status="inbox" onStatus={()=>{}} query="" onSearch={()=>{}} onCompose={()=>{}}><textarea aria-label="Unsent draft" defaultValue="An unfinished thought" /></DaylightShell>;
}
it("keeps the same draft node across layouts and full window, reopens the modal, and restores the dashboard",async()=>{
 const writes:any[]=[];
 vi.stubGlobal("fetch",async(path:string,init:RequestInit)=>{
  if(path.endsWith("preferences-save")) {writes.push(JSON.parse(init.body as string));return response({});}
  return response({preferences:{navigation:"top",fullWindow:false},canSave:true,name:"Alex"});
 });
 document.body.style.overflow="scroll";
 await act(()=>root.render(<NavigationProvider><Harness /></NavigationProvider>));
 const editor=document.querySelector("textarea")!;editor.value="Keep this draft";editor.focus();
 await act(()=>document.querySelector<HTMLButtonElement>('[aria-label="Appearance and layout"]')!.click());
 await act(()=>button("Left navigationYour folders always in reach.").click());
 expect(document.querySelector(".dl-root")?.getAttribute("data-navigation")).toBe("left");
 await act(()=>document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
 expect(document.querySelector("textarea")).toBe(editor);
 expect(editor.value).toBe("Keep this draft");
 expect(container.inert).toBe(true);
 expect(document.body.style.overflow).toBe("hidden");
 expect(document.querySelector("dialog")?.open).toBe(true);
 await act(()=>button("Done").click());
 await act(()=>button("Use dashboard view").click());
 expect(document.querySelector("textarea")).toBe(editor);
 expect(container.inert).not.toBe(true);
 expect(document.body.style.overflow).toBe("scroll");
 expect(writes.at(-1)).toEqual({navigation:"left",fullWindow:false});
 document.body.style.overflow="";
});
it("does not claim a layout was saved when the preference write fails",async()=>{
 vi.stubGlobal("fetch",async(path:string)=>path.endsWith("preferences-save")?new Response(JSON.stringify({error:{message:"Save failed"}}),{status:503}):response({preferences:{navigation:"top",fullWindow:false},canSave:true}));
 await act(()=>root.render(<Harness />));
 await act(()=>document.querySelector<HTMLButtonElement>('[aria-label="Appearance and layout"]')!.click());
 await act(()=>button("Left navigationYour folders always in reach.").click());
 expect(document.querySelector(".dl-root")?.getAttribute("data-navigation")).toBe("top");
 expect(document.querySelector('[role="alert"]')?.textContent).toBe("Save failed");
});
it("protects unsaved work on navigation and unload, then removes the guard on unmount",async()=>{
 const leave=vi.fn(()=>false);let allowed:boolean|undefined;
 function Guard(){useLeaveGuard({canLeave:leave,hasUnsaved:()=>true});return null;}
 function View({guard}:{guard:boolean}){const allow=useMailNavigation();return <>{guard&&<Guard />}<button onClick={()=>{allowed=allow();}}>Leave</button></>;}
 await act(()=>root.render(<NavigationProvider><View guard /></NavigationProvider>));
 await act(()=>button("Leave").click());expect(allowed).toBe(false);expect(leave).toHaveBeenCalledTimes(1);
 const event=new Event("beforeunload",{cancelable:true});window.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);
 await act(()=>root.render(<NavigationProvider><View guard={false} /></NavigationProvider>));
 await act(()=>button("Leave").click());expect(allowed).toBe(true);
});

it("blocks host sidebar navigation before its router can unmount an unsaved editor",async()=>{
 let mayLeave=false;
 function Editor(){useLeaveGuard({canLeave:()=>mayLeave,hasUnsaved:()=>!mayLeave});return <textarea defaultValue="Keep this draft" />;}
 const sidebar=document.createElement("a");sidebar.href="/_emdash/admin/";sidebar.textContent="Dashboard";document.body.append(sidebar);
 let navigated=false;
 sidebar.addEventListener("click",event=>{event.preventDefault();navigated=true;});
 try {
  await act(()=>root.render(<NavigationProvider><Editor /></NavigationProvider>));
  await act(()=>sidebar.click());
  expect(navigated).toBe(false);
  expect(document.querySelector("textarea")?.value).toBe("Keep this draft");
  mayLeave=true;
  await act(()=>sidebar.click());
  expect(navigated).toBe(true);
 } finally {sidebar.remove();}
});

it("leaves new-tab links, downloads, and same-page anchors usable while editing",async()=>{
 function Editor(){useLeaveGuard({canLeave:()=>false,hasUnsaved:()=>true});return null;}
 const link=document.createElement("a");link.href="/_emdash/admin/";document.body.append(link);
 let reached=false;
 link.addEventListener("click",event=>{event.preventDefault();reached=true;});
 const click=(init:MouseEventInit={})=>{reached=false;link.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,...init}));expect(reached).toBe(true);};
 try {
  await act(()=>root.render(<NavigationProvider><Editor /></NavigationProvider>));
  click({metaKey:true});click({ctrlKey:true});click({shiftKey:true});click({button:1});
  link.target="_blank";click();link.target="";
  link.download="mail.txt";click();link.removeAttribute("download");
  link.href="#details";click();
  link.href="mailto:hi@example.com";click();
  await act(()=>root.render(<NavigationProvider>{null}</NavigationProvider>));
  link.href="/_emdash/admin/";click();
 } finally {link.remove();}
});
