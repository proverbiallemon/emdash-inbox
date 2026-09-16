// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHost } from './helpers/nativeHost';
const cloud = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>(), send: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {
 EMAIL: { send: cloud.send },
 INBOX_ATTACHMENTS: {
  async put(key: string, value: ArrayBuffer | Uint8Array) { cloud.objects.set(key, new Uint8Array(value instanceof Uint8Array ? value : value).slice()); },
  async get(key: string) { const bytes=cloud.objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async()=>bytes.slice().buffer } : null; },
  async delete(key: string | string[]) { for (const k of Array.isArray(key)?key:[key]) cloud.objects.delete(k); },
 }
} }));
describe('M8b native routes',()=>{
 let host: Awaited<ReturnType<typeof createNativeHost>>;
 beforeEach(async()=>{ cloud.objects.clear(); cloud.send.mockReset().mockResolvedValue({messageId:'<attached@example.com>'}); host=await createNativeHost(); });
 afterEach(async()=>{await host?.close();});
 it('preserves incoming attachment bytes and exposes only authenticated metadata',async()=>{
  const raw=['From: sender@example.com','To: owner@example.com','Message-ID: <file@example.com>','Subject: Private file','MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="b"','','--b','Content-Type: text/plain','','Body','--b','Content-Type: application/octet-stream','Content-Disposition: attachment; filename="fixture.bin"','Content-Transfer-Encoding: base64','','AAH+/w==','--b--',''].join('\r\n');
  const incoming=await host.request('inbound',{rawMimeBase64:Buffer.from(raw).toString('base64')},{'X-Inbound-Secret':'test-only-inbound-secret'});
  expect(incoming.success,JSON.stringify(incoming)).toBe(true);
  const id=(incoming.data as any).id;
  const stored=await host.messages.get(id) as any;
  expect(stored.bodyRaw).toBeNull();
  expect(stored.attachments).toHaveLength(1);
  const thread=await host.request('messages/thread',{id});
  expect(thread.success).toBe(true);
  expect(JSON.stringify(thread.data)).not.toContain(stored.rawObjectKey);
  expect(JSON.stringify(thread.data)).not.toContain(stored.attachments[0].objectKey);
  const file=await host.request('attachments/read',{messageId:id,attachmentId:stored.attachments[0].id});
  expect(file.success,JSON.stringify(file)).toBe(true);
  expect((file.data as any).contentBase64).toBe('AAH+/w==');
  expect(host.plugin.routes['attachments/read'].public).not.toBe(true);
  expect(host.plugin.routes['attachments/read'].permission).toBe('plugins:manage');
  const wrong=await host.request('attachments/read',{messageId:id,attachmentId:'not-owned'});
  expect(wrong.success).toBe(false);
 });
 it('sends a saved attachment and keeps it available on the sent message',async()=>{
  const saved=await host.request('messages/draft-save',{to:'reader@example.com',subject:'File',text:'Attached'});
  const draftId=(saved.data as any).draftId;
  const uploaded=await host.request('attachments/upload',{draftId,filename:'hello.txt',mimeType:'text/plain',contentBase64:'aGVsbG8='});
  expect(uploaded.success,JSON.stringify(uploaded)).toBe(true);
  const attachment=(uploaded.data as any).attachment;
  const sent=await host.request('messages/draft-send',{draftId});
  expect(sent.success,JSON.stringify(sent)).toBe(true);
  expect((sent.data as any).id).toBe(draftId);
  expect(await host.messages.get(draftId)).toMatchObject({status:'done',deliveryProjected:true});
  const deliveredFile=cloud.send.mock.calls[0][0].attachments[0];
  expect(deliveredFile).toMatchObject({filename:'hello.txt',type:'text/plain'});
  expect(deliveredFile.content).toBeInstanceOf(ArrayBuffer);
  expect(Buffer.from(deliveredFile.content)).toEqual(Buffer.from('hello'));
  const read=await host.request('attachments/read',{messageId:(sent.data as any).id,attachmentId:attachment.id});
  expect(read.success,JSON.stringify(read)).toBe(true);
 expect((read.data as any).contentBase64).toBe('aGVsbG8=');
 });
 it('passes the original binary file to the Workers binding instead of its base64 text',async()=>{
  const bytes=Buffer.alloc(512*1024); for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
  const saved=await host.request('messages/draft-save',{to:'reader@example.com',subject:'Binary transport',text:'Attached'});
  const draftId=(saved.data as any).draftId;
  const uploaded=await host.request('attachments/upload',{draftId,filename:'pattern.bin',mimeType:'application/octet-stream',contentBase64:bytes.toString('base64')});
  expect(uploaded.success,JSON.stringify(uploaded)).toBe(true);
  const sent=await host.request('messages/draft-send',{draftId});
  expect(sent.success,JSON.stringify(sent)).toBe(true);
  const deliveredFile=cloud.send.mock.calls[0][0].attachments[0];
  expect(deliveredFile.content).toBeInstanceOf(ArrayBuffer);
  expect(Buffer.from(deliveredFile.content)).toEqual(bytes);
 });
 it('rejects decoded message bodies too large for mailbox storage',async()=>{
  const rawMime='From: sender@example.com\r\nMessage-ID: <large-body@example.com>\r\n\r\n'+'x'.repeat(256*1024+1);
  const result=await host.request('inbound',{rawMime},{'X-Inbound-Secret':'test-only-inbound-secret'});
  expect(result.success).toBe(false);
  expect((await host.messages.query({})).items).toHaveLength(0);
 });
 it('makes attachments accessible by storage ID through native MCP',async()=>{
  const saved=await host.request('mcp/save_draft',{to:'reader@example.com',subject:'MCP file',text:'Attached'});
  const draftId=(saved.data as any).draftId;
  const uploaded=await host.request('mcp/add_draft_attachment',{draftId,filename:'mcp.txt',mimeType:'text/plain',contentBase64:'bWNw'});
  expect(uploaded.success,JSON.stringify(uploaded)).toBe(true);
  const sent=await host.request('mcp/send_draft',{draftId});
  const thread=await host.request('mcp/get_thread',{threadId:(sent.data as any).threadId});
  const message=(thread.data as any[])[0];
  expect(message.id).toBe((sent.data as any).id);
  expect(message.attachments[0].objectKey).toBeUndefined();
  const read=await host.request('mcp/read_attachment',{messageId:message.id,attachmentId:message.attachments[0].id});
  expect((read.data as any).contentBase64).toBe('bWNw');
 });
 it('rejects an oversized inbound envelope before parsing or saving it',async()=>{
  const result=await host.request('inbound',{rawMimeBase64:'A'.repeat(12*1024*1024)},{'X-Inbound-Secret':'test-only-inbound-secret'});
  expect(result.success).toBe(false);
  expect((await host.messages.query({})).items).toHaveLength(0);
  expect(cloud.objects.size).toBe(0);
 });
});
