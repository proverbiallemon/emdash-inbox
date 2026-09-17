// This adapter exists only in the local Vite preview. It makes no network requests.
import { aggregateThreads } from "../src/lib/threadSummary";
import type { MessageDoc } from "../src/index";
import { BUNDLE_IDS, type BundleId } from "../src/lib/bundles";
import type { InboxPreferences } from "../src/lib/uiPreferences";
let preferences: InboxPreferences = { navigation: "top", fullWindow: false, enabledBundles: [...BUNDLE_IDS], bundledInbox: true };
const owner = "alex@example.com";
const previewText = "A quieter kind of inbox\n\nOne place for the conversations that matter.\nBuilt around your own pace.\n\nThis attachment is a local preview fixture.";
const file = { id: "sample-note", filename: "Daylight-notes.txt", mimeType: "text/plain", size: new TextEncoder().encode(previewText).length };
const names = [
 ["Mara Chen <mara@example.com>", "A fresh direction for the studio", "I’ve attached a few notes for our next conversation. I think the extra breathing room makes all the difference."],
 ["Studio North <studio@example.com>", "Friday’s open studio", "A few good people, new work on the walls, and coffee on us. Come by any time after four."],
 ["Sam Rivera <sam@example.com>", "Coffee next week?", "Tuesday looks good on my end. The little place on Main?"],
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
 bodyRaw: "", receivedAt: date, sortAt: date, status: index === 5 ? "snoozed" : index === 0 || index === 2 ? "inbox" : "done", pinned: index === 0, read: index > 2, snoozeUntil: index === 5 ? new Date(Date.now()+86400000).toISOString() : null, source: "inbound", bundleId: null, inReplyTo: null, ...(index === 0 ? {attachments:[file]} : {}) } as MessageDoc };
});
rows.unshift({ id:"mail-older", data: {...rows[0].data, messageId:"<older@example.com>", bodyText:"Would love your thoughts on the new direction.",bodyHtml:null,receivedAt:new Date(Date.now()-86400000).toISOString(),sortAt:new Date(Date.now()-86400000).toISOString(),attachments:[]} });
const categories = [
 ["orders", "Oak Supply <orders@oaksupply.example>", "Thanks for your order #1048", "Desk lamp, warm white. Your order receipt is ready."],
 ["shipping", "Parcel Post <tracking@parcel.example>", "Your package is on the way", "Your parcel will arrive on Thursday."],
 ["commissions", "Lumen Studio <art@lumen.example>", "A new commission for the studio", "We would love to discuss a commissioned piece."],
 ["fans", "Nina <nina@letters.example>", "Your latest work made my day", "A small note to say how much your work means to me."],
 ["promos", "Studio Shop <offers@studioshop.example>", "A little something for your workspace", "Our seasonal sale starts today."],
 ["updates", "Creative Weekly <news@creative.example>", "This week in the studio", "Your weekly newsletter and creative news."],
] as const;
for (const [bundle,from,subject,bodyText] of categories) for(let index=0;index<({orders:3,shipping:2,commissions:2,fans:4,promos:5,updates:2}[bundle]);index++) {
 const id=`${bundle}-${index}`;const date=new Date(Date.now()-(index+1)*7200000).toISOString();
 const orderSenders=['orders@oaksupply.example','receipts@paperandclay.example','orders@studioshop.example'];
 rows.push({id,data:{...rows[1].data,messageId:`<${id}@example.com>`,threadId:id,from:bundle==='orders'?orderSenders[index]:from.match(/<([^>]+)>/)![1],subject:bundle==='orders'?['Thanks for your order #1048','Your sketchbooks are on their way','We’re getting your order ready'][index]:subject,bodyText,bodyHtml:`<p>${bodyText}</p>`,receivedAt:date,sortAt:date,status:'inbox',pinned:false,read:index>=({orders:2,shipping:1,commissions:1,fans:2,promos:3,updates:1}[bundle]),attachments:[],bundleEvidence:{version:1,assignment:{bundle,source:bundle==='fans'||bundle==='commissions'?'sender':'builtin'}}}});
}
type Scenario = 'normal'|'partial'|'unknown'|'conflict'|'move-partial'|'move-error'|'settings-error'|'indexing'|'overview-error';
let scenario:Scenario='normal';let scenarioUsed=false;
export function setBundleScenario(value:Scenario){scenario=value;scenarioUsed=false;}
const rules=new Map<string,{version:1;id:string;sender:string;bundle:BundleId|null}>();
const operations=new Map<string,any>();
const overrides=new Map<string,BundleId|null>();
try{const saved=JSON.parse(sessionStorage.getItem('daylight-preview-operations')??'null');if(saved){rows=saved.rows;for(const [threadId,bundle] of saved.overrides??[])overrides.set(threadId,bundle);for(const op of saved.operations)operations.set(op.id,op);}}catch{}
function persistFixture(){sessionStorage.setItem('daylight-preview-operations',JSON.stringify({rows,operations:[...operations.values()],overrides:[...overrides]}));}
function withSender(items:ReturnType<typeof aggregateThreads>){return items.map(item=>({...item,...(overrides.has(item.threadId)?{bundle:{bundle:overrides.get(item.threadId)!,source:'manual' as const}}:{}),bundleSender:rows.filter(row=>row.data.threadId===item.threadId&&row.data.direction==='inbound').sort((a,b)=>b.data.sortAt.localeCompare(a.data.sortAt))[0]?.data.from??null}));}
function inboxRows(){return withSender(aggregateThreads(rows,'inbox',owner));}
function operationView(op:any){const counts={pending:0,done:0,failed:0,skipped:0};for(const item of op.items)counts[item.outcome as keyof typeof counts]++;return {id:op.id,bundle:op.bundle,phase:op.phase,total:op.items.length,unreadCount:op.unreadCount,counts,outcomes:counts,retryable:counts.failed>0,workRemaining:op.phase==='running'||op.phase==='preparing',hasMore:op.phase==='running'||op.phase==='preparing'};}
function fixtureError(message:string,status=503){return new Response(JSON.stringify({error:{message}}),{status,headers:{'Content-Type':'application/json'}});}
let drafts: any[] = [{ id:"draft-sample", to:["mara@example.com"], cc:[],bcc:[],subject:"A thought for next week", bodyText:"I’ve been thinking about our conversation.",bodyHtml:"<p>I’ve been thinking about our conversation.</p>",threadId:null,attachments:[],receivedAt:new Date().toISOString(),sortAt:new Date().toISOString() }];
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export async function parseApiResponse<T>(response: Response, fallback = "Request failed"): Promise<T> { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || fallback); return body.data; }
export async function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
 const path = String(input).split("/emdash-inbox/")[1]; const body = JSON.parse(String(init?.body ?? "{}"));
 await new Promise(resolve => setTimeout(resolve, 90));
 let data: any;
 switch(path) {
  case 'bundles/overview': {
   if(scenario==='overview-error'&&!scenarioUsed){scenarioUsed=true;return fixtureError('Could not load the Inbox overview.');}
   const all=inboxRows();data={totalCount:all.length,unreadCount:all.filter(r=>r.unreadCount>0).length,bundles:BUNDLE_IDS.map(id=>{const matching=all.filter(r=>!r.pinned&&r.bundle?.bundle===id);return {id,count:matching.length,unreadCount:matching.filter(r=>r.unreadCount>0).length,senders:[...new Set(matching.map(r=>r.bundleSender??r.latest.from))].slice(0,3)};}),...(scenario==='indexing'&&!scenarioUsed?{indexing:true}:{})};if(scenario==='indexing')scenarioUsed=true;break;
  }
  case 'bundles/list': {
   const enabled=body.enabled??BUNDLE_IDS;const items=inboxRows().filter(r=>body.section==='conversations'?r.pinned||!r.bundle?.bundle||!enabled.includes(r.bundle.bundle):!r.pinned&&r.bundle?.bundle===body.section);const start=Number(body.cursor??0);const limit=body.limit??25;data={items:items.slice(start,start+limit),hasMore:items.length>start+limit,...(items.length>start+limit?{cursor:String(start+limit)}:{})};break;
  }
  case 'bundles/rules': data={rules:[...rules.values()],explanation:'Conversation choices come first, then exact sender rules saved when incoming mail arrived, then built-in matching. Future sender rules never regroup historical mail.'};break;
  case 'bundles/move': {
   const matching=rows.filter(r=>r.data.threadId===body.threadId);const newest=matching.at(-1);const sender=newest?.data.from;
   if(!newest)return fixtureError('Conversation not found',404);
   if(scenario==='move-error'&&!scenarioUsed){scenarioUsed=true;return fixtureError('Could not move this conversation. Please retry.');}
   if(body.saveSenderRule&&scenario==='conflict'&&!body.replaceRule){rules.set(sender!,{version:1,id:sender!,sender:sender!,bundle:'updates'});return fixtureError('A rule already exists for this sender; explicitly replace it to continue',409);}
   overrides.set(body.threadId,body.bundle);
   data={moved:true,assignment:{bundle:body.bundle,source:'manual'}};
   if(body.saveSenderRule){if(scenario==='move-partial'&&!scenarioUsed){scenarioUsed=true;data.ruleSaved=false;data.ruleError='Conversation moved, but the future sender rule could not be saved. Review the current rule and retry.';}else{rules.set(sender!,{version:1,id:sender!,sender:sender!,bundle:body.bundle});data.ruleSaved=true;}}
   persistFixture();break;
  }
  case 'bundles/done-prepare': {
   let op=[...operations.values()].find(op=>op.requestId===body.requestId);
   if(!op){const matching=inboxRows().filter(r=>!r.pinned&&r.bundle?.bundle===body.bundle);op={id:crypto.randomUUID(),requestId:body.requestId,bundle:body.bundle,phase:'ready',unreadCount:matching.filter(r=>r.unreadCount>0).length,items:matching.map(r=>({threadId:r.threadId,openMessageId:r.openMessageId,outcome:'pending'}))};operations.set(op.id,op);persistFixture();}data=operationView(op);break;
  }
  case 'bundles/done-run': {
   const op=operations.get(body.operationId);if(!op)return fixtureError('Operation not found',404);
   if(op.phase==='complete'&&!body.retry){data=operationView(op);break;}
   if(body.retry)for(const item of op.items)if(item.outcome==='failed')item.outcome='pending';
   const pending=op.items.filter((item:any)=>item.outcome==='pending');
   for(const item of pending.slice(0,2)){if(scenario==='partial'&&!scenarioUsed&&(op.bundle!=='orders'||item.threadId==='orders-1')){scenarioUsed=true;item.outcome='failed';item.reason='storage_failure';}else{item.outcome='done';delete item.reason;rows.filter(r=>r.data.threadId===item.threadId).forEach(r=>r.data.status='done');}}
   op.phase=op.items.some((item:any)=>item.outcome==='pending')?'running':'complete';persistFixture();
   if(scenario==='unknown'&&!scenarioUsed){scenarioUsed=true;throw new Error('Connection lost after the server saved this batch.');}data=operationView(op);break;
  }
  case 'bundles/done-status': {const op=operations.get(body.operationId);if(!op)return fixtureError('Operation not found',404);data=operationView(op);break;}
  case 'bundles/done-threads': {const op=operations.get(body.operationId);if(!op)return fixtureError('Operation not found',404);const all=withSender(aggregateThreads(rows,'all',owner));const start=Number(body.cursor??0);data={items:op.items.slice(start,start+25).map((item:any)=>({...item,summary:all.find(r=>r.threadId===item.threadId)??null})),hasMore:op.items.length>start+25,...(op.items.length>start+25?{cursor:String(start+25)}:{})};break;}

  case "ui/preferences": data = { preferences, userId:"daylight-preview-user", canSave:true, name:"Alex Morgan", senderAddress:owner }; break;
  case "ui/preferences-save": if(scenario==='settings-error'&&!scenarioUsed){scenarioUsed=true;return fixtureError("Could not save your bundle settings. Try again.");} preferences=body; data={preferences}; break;
  case "threads/list": data={items:withSender(aggregateThreads(rows,body.status??"inbox",owner)).filter(row=>!body.pinnedOnly||row.pinned),hasMore:false}; break;
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

