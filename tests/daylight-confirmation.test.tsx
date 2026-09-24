import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposeView } from "../src/components/ComposeView";
import { ReplyCompose } from "../src/components/ReplyCompose";
import { NavigationProvider, useMailNavigation } from "../src/daylight/navigation";

vi.mock("../src/lib/signatureClient", () => ({ getSignature: async () => ({ signature: { text: "", newMessages: true, replies: true }, canSave: true }) }));

vi.mock("../src/components/TipTapEditor", () => ({
 TipTapEditor: ({ onReady }: { onReady: (editor: any) => void }) => {
  const editor=React.useMemo(()=>({getHTML:()=>"<p>Keep this message</p>",getText:()=>"Keep this message",commands:{focus(){}},setEditable(){}}),[]);
  React.useEffect(()=>onReady(editor),[onReady,editor]);
  return <div aria-label="Editor">Keep this message</div>;
 },
}));
vi.mock("../src/components/ComposeToolbar",()=>({ComposeToolbar:()=>null}));
let container:HTMLDivElement;let root:Root;
function response(data:unknown){return new Response(JSON.stringify({success:true,data}),{headers:{"Content-Type":"application/json"}});}
async function act(action:()=>void){await React.act(async()=>{action();});}
function button(label:string){const found=[...container.querySelectorAll("button")].find(node=>node.textContent?.trim()===label);expect(found,`Missing ${label}`).toBeDefined();return found!;}
async function click(label:string){await act(()=>button(label).click());}
async function editSubject(){await act(()=>{const input=[...container.querySelectorAll("label")].find(node=>node.textContent?.trim()==="Subject")!.querySelector("input")!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"Unsaved subject");input.dispatchEvent(new Event("input",{bubbles:true}));});}
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(){this.open=false;}});
 vi.spyOn(window,"confirm").mockReturnValue(false);
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});

it.each(["compose","reply"])("keeps %s edits on cancel and closes without deleting on leave",async(mode)=>{
 let closed=false;const requests:string[]=[];
 vi.stubGlobal("fetch",async(path:string)=>{requests.push(path);return response({});});
 await act(()=>root.render(mode==="compose"?<ComposeView draftId={null} onClose={()=>{closed=true;}}/>:<ReplyCompose defaults={{to:"reader@example.com",subject:"Hello",quoteHtml:""}} inReplyTo="parent" threadId="thread" onSent={()=>{}} onDiscard={()=>{closed=true;}}/>));
 await editSubject();const editor=container.querySelector('[aria-label="Editor"]');
 const close=mode==="compose"?"← Inbox":"Close";
  await click(close);
  expect(container.querySelector("dialog[open]")?.textContent).toContain("Leave without saving?");
  expect(document.activeElement).toBe(button("Keep editing"));
 await click("Keep editing");
 expect(closed).toBe(false);expect(container.querySelector('[aria-label="Editor"]')).toBe(editor);
 await click(close);await click("Leave without saving");
 expect(closed).toBe(true);expect(requests).toEqual([]);
});

it("cancels a suspended destination when its editor is removed",async()=>{
 let navigated=false;
 function Link(){const allow=useMailNavigation();return <button onClick={async()=>{if(await allow())navigated=true;}}>Leave editor</button>;}
 const view=(editor:boolean)=><NavigationProvider><Link/>{editor&&<ComposeView draftId={null} onClose={()=>{}}/>}</NavigationProvider>;
 await act(()=>root.render(view(true)));await editSubject();await click("Leave editor");
 expect(container.querySelector("dialog[open]")).not.toBeNull();
 await act(()=>root.render(view(false)));
 expect(navigated).toBe(false);expect(container.querySelector("dialog")).toBeNull();
});

it("deletes only the selected saved draft after explicit confirmation",async()=>{
 const removed:string[]=[];let closed=false;
 vi.stubGlobal("fetch",async(path:string,init:RequestInit)=>{
  if(path.endsWith("messages/drafts"))return response({items:[{id:"saved-draft",to:["reader@example.com"],cc:[],bcc:[],subject:"Saved",bodyHtml:"<p>Keep this message</p>",bodyText:"Keep this message",threadId:null}]});
  if(path.endsWith("draft-discard")){removed.push(JSON.parse(init.body as string).draftId);return response({discarded:true});}
  throw new Error(`Unexpected ${path}`);
 });
 await act(()=>root.render(<ComposeView draftId="saved-draft" onClose={()=>{closed=true;}}/>));
 await click("Discard");expect(container.querySelector("dialog[open]")?.textContent).toContain("Discard this email?");
 await click("Keep editing");expect(removed).toEqual([]);expect(closed).toBe(false);
 await click("Discard");await click("Discard email");expect(removed).toEqual(["saved-draft"]);expect(closed).toBe(true);
});

it("cancels with Escape and blocks a host link until the editor confirms",async()=>{
 let navigated=false;
 const hostLink=document.createElement("a");hostLink.href="/_emdash/admin/";hostLink.textContent="Dashboard";document.body.append(hostLink);
 hostLink.addEventListener("click",event=>{event.preventDefault();navigated=true;});
 try{
  await act(()=>root.render(<NavigationProvider><ComposeView draftId={null} onClose={()=>{}}/></NavigationProvider>));
  await editSubject();
  await act(()=>hostLink.click());
  expect(navigated).toBe(false);const dialog=container.querySelector("dialog[open]");expect(dialog).not.toBeNull();
  await act(()=>dialog!.dispatchEvent(new Event("cancel",{cancelable:true})));
  expect(container.querySelector("dialog[open]")).toBeNull();expect(navigated).toBe(false);
  expect(container.querySelector('[aria-label="Editor"]')).not.toBeNull();
 }finally{hostLink.remove();}
});

it("does not queue competing destinations behind one confirmation",async()=>{
 const destinations:string[]=[];
 function Links(){const allow=useMailNavigation();return <>{["First","Second"].map(label=><button key={label} onClick={async()=>{if(await allow())destinations.push(label);}}>{label}</button>)}</>;}
 await act(()=>root.render(<NavigationProvider><Links/><ComposeView draftId={null} onClose={()=>{}}/></NavigationProvider>));
 await editSubject();
 await act(()=>{button("First").click();button("Second").click();});
 expect(destinations).toEqual([]);await click("Leave without saving");expect(destinations).toEqual(["First"]);
});

it("wraps Tab and Shift-Tab inside the confirmation",async()=>{
 await act(()=>root.render(<ComposeView draftId={null} onClose={()=>{}}/>));await editSubject();await click("Discard");
 const dialog=container.querySelector<HTMLDialogElement>('dialog[open]')!;
 const first=dialog.querySelector<HTMLButtonElement>('button')!;const last=button("Discard email");
 for(const element of dialog.querySelectorAll<HTMLElement>('button'))vi.spyOn(element,'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
 last.focus();const forward=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});await act(()=>last.dispatchEvent(forward));
 expect(forward.defaultPrevented).toBe(true);expect(document.activeElement).toBe(first);
 const backward=new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true});await act(()=>first.dispatchEvent(backward));
 expect(backward.defaultPrevented).toBe(true);expect(document.activeElement).toBe(last);
});
