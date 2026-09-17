// This adapter exists only in the local Vite preview. It makes no network requests.
import { aggregateThreads } from "../src/lib/threadSummary";
import type { MessageDoc } from "../src/index";
let preferences = { navigation: "top", fullWindow: false };
const owner = "alex@example.com";
const previewText = "A quieter kind of inbox\n\nOne place for the conversations that matter.\nBuilt around your own pace.\n\nThis attachment is a local preview fixture.";
const file = { id: "sample-note", filename: "Daylight-notes.txt", mimeType: "text/plain", size: new TextEncoder().encode(previewText).length };
const names = [
 ["Mara Chen <mara@example.com>", "A quieter kind of inbox", "I’ve attached a few notes for our next conversation. I think the extra breathing room makes all the difference."],
 ["Studio North <studio@example.com>", "Friday’s open studio", "A few good people, new work on the walls, and coffee on us. Come by any time after four."],
 ["Luis Rivera <luis@example.com>", "A small idea for the weekend", "There’s a new trail by the river I think you’d love. Shall we make a morning of it?"],
 ["Field Notes <notes@example.com>", "The things worth noticing", "This week: a little less noise, a little more attention. A collection of things we kept coming back to."],
 ["Nora Bell <nora@example.com>", "Your reading list, with a few additions", "I added the two books we were talking about. No rush — they’ll be here when you’re ready."],
 ["The Workshop <hello@example.com>", "Your place is saved", "We’re looking forward to seeing you next month. Here are the details for your visit."],
 ["Jules <jules@example.com>", "Coffee next week?", "Tuesday or Thursday looks good on my end. Let me know what works for you."],
 ["Alex Morgan <alex@example.net>", "Thanks for the thoughtful feedback", "This is exactly the direction we were hoping for. I’ll share the updated version tomorrow."],
];
let rows = names.map(([from, subject, bodyText], index) => {
 const date = new Date(Date.now() - (index < 3 ? index + 1 : index * 7) * 3600000).toISOString();
 return { id: "mail-" + index, data: { messageId: "<mail-" + index + "@example.com>", threadId: "thread-" + index, direction: "inbound", from: from.match(/<([^>]+)>/)?.[1] ?? from, to: owner, toAll: [owner], cc: index === 0 ? ["luis@example.com"] : [], subject, bodyText,
 bodyHtml: "<p>Hi Alex,</p><p>" + bodyText + "</p><p>Speak soon,<br>" + from.split(" ")[0] + "</p>",
 bodyRaw: "", receivedAt: date, sortAt: date, status: index === 5 ? "snoozed" : index === 7 ? "done" : "inbox", pinned: index === 0, read: index > 2, snoozeUntil: index === 5 ? new Date(Date.now()+86400000).toISOString() : null, source: "inbound", bundleId: null, inReplyTo: null, ...(index === 0 ? {attachments:[file]} : {}) } as MessageDoc };
});
rows.unshift({ id:"mail-older", data: {...rows[0].data, messageId:"<older@example.com>", bodyText:"Would love your thoughts on the new direction.",bodyHtml:null,receivedAt:new Date(Date.now()-86400000).toISOString(),sortAt:new Date(Date.now()-86400000).toISOString(),attachments:[]} });
let drafts: any[] = [{ id:"draft-sample", to:["mara@example.com"], cc:[],bcc:[],subject:"A thought for next week", bodyText:"I’ve been thinking about our conversation.",bodyHtml:"<p>I’ve been thinking about our conversation.</p>",threadId:null,attachments:[],receivedAt:new Date().toISOString(),sortAt:new Date().toISOString() }];
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export async function parseApiResponse<T>(response: Response, fallback = "Request failed"): Promise<T> { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || fallback); return body.data; }
export async function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
 const path = String(input).split("/emdash-inbox/")[1]; const body = JSON.parse(String(init?.body ?? "{}"));
 await new Promise(resolve => setTimeout(resolve, 90));
 let data: any;
 switch(path) {
  case "ui/preferences": data = { preferences, canSave:true, name:"Alex Morgan", senderAddress:owner }; break;
  case "ui/preferences-save": preferences=body; data={preferences}; break;
  case "threads/list": data={items:aggregateThreads(rows,body.status??"inbox",owner).filter(row=>!body.pinnedOnly||row.pinned),hasMore:false}; break;
  case "messages/search": data={items:rows.filter(row=>(row.data.subject+" "+row.data.bodyText).toLowerCase().includes(body.query.toLowerCase())).map(row=>({id:row.id,...row.data})),hasMore:false};break;
  case "messages/thread": {
   const item=rows.find(row=>row.id===body.id);
   const thread=rows.filter(row=>row.data.threadId===item?.data.threadId).sort((a,b)=>a.data.receivedAt.localeCompare(b.data.receivedAt));
   thread.forEach(row=>row.data.read=true); data={items:thread};break;
  }
  case "threads/action": rows.filter(row=>row.data.threadId===body.threadId).forEach(row=>{if(body.action==="pin")row.data.pinned=body.pinned;else{row.data.status=body.status;row.data.snoozeUntil=body.snoozeUntil??null;}}); data={updated:1};break;
  case "messages/drafts": data={items:drafts.map(draft=>({...draft,updatedAt:draft.receivedAt,snippet:draft.bodyText}))};break;
  case "messages/draft-save": {
   const id=body.draftId??crypto.randomUUID(); const existing=drafts.find(row=>row.id===id);
   const addresses=(value:string|string[])=>Array.isArray(value)?value:(value??"").split(",").map(value=>value.trim()).filter(Boolean);
   const draft={id,to:addresses(body.to),cc:addresses(body.cc),bcc:addresses(body.bcc),subject:body.subject,bodyHtml:body.html,bodyText:body.text,threadId:body.threadId??null,attachments:existing?.attachments??[],receivedAt:new Date().toISOString()};
   drafts=[...drafts.filter(row=>row.id!==id),draft];data={draftId:id};break;
  }
  case "messages/draft-discard": drafts=drafts.filter(row=>row.id!==body.draftId);data={ok:true};break;
  case "messages/compose":case "messages/reply":case "messages/draft-send": data={id:"sample-sent",threadId:"sample-thread",attemptId:"sample-delivery",deliveryStatus:"sent"};drafts=drafts.filter(row=>row.id!==body.draftId);break;
  case "deliveries/list": data={items:[],hasMore:false};break;
  case "deliveries/reconcile":data={recovered:0,restored:0,uncertain:0};break;
  case "attachments/read":data={attachment:file,offset:0,contentBase64:btoa(unescape(encodeURIComponent(previewText))),nextOffset:null,done:true};break;
  case "attachments/upload": {
   const attachment={id:crypto.randomUUID(),filename:body.filename,mimeType:body.mimeType,size:atob(body.contentBase64).length};
   drafts.find(row=>row.id===body.draftId)?.attachments.push(attachment);data={attachment};break;
  }
  case "attachments/remove": {const draft=drafts.find(row=>row.id===body.draftId);if(draft)draft.attachments=draft.attachments.filter((file:any)=>file.id!==body.attachmentId);data={ok:true};break;}
  default:return new Response(JSON.stringify({error:{message:"This action is not part of the local preview."}}),{status:400});
 }
 return new Response(JSON.stringify({success:true,data}),{headers:{"Content-Type":"application/json"}});
}

