// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import worker from '../examples/inbound-email-worker/index';
afterEach(()=>vi.unstubAllGlobals());
it('forwards exact MIME bytes without UTF-8 replacement',async()=>{
 const bytes=new Uint8Array([65,0,128,255,13,10]);let received='';
 vi.stubGlobal('fetch',async(_url:unknown,input:RequestInit)=>{received=JSON.parse(input.body as string).rawMimeBase64;return new Response('{}');});
 const reject=vi.fn();await worker.email({from:'a@example.com',to:'b@example.com',raw:new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),rawSize:bytes.length,setReject:reject,forward:async()=>{},reply:async()=>{}},{INBOUND_URL:'https://host.example/inbound',INBOUND_SECRET:'test'},{waitUntil(){}});
 expect(received).toBe('QQCA/w0K');expect(reject).not.toHaveBeenCalled();
});
it('rejects oversized mail before buffering or forwarding its body',async()=>{
 const post=vi.fn();vi.stubGlobal('fetch',post);const reject=vi.fn();
 await worker.email({from:'a@example.com',to:'b@example.com',raw:new ReadableStream({start(c){c.close();}}),rawSize:8*1024*1024+1,setReject:reject,forward:async()=>{},reply:async()=>{}},{INBOUND_URL:'https://host.example/inbound',INBOUND_SECRET:'test'},{waitUntil(){}});
 expect(reject).toHaveBeenCalled();expect(post).not.toHaveBeenCalled();
});
