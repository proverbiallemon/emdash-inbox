import { expect, it, vi } from 'vitest';
import { BundleOperationClient } from '../src/daylight/bundleClient';
const ready = {id:'opaque-id',bundle:'orders',phase:'ready',total:3,unreadCount:2,counts:{pending:3,done:0,skipped:0,failed:0},retryable:false};
it('prepares all bounded pages, confirms once and stops at completion',async()=>{
 const post=vi.fn().mockResolvedValueOnce({...ready,phase:'preparing'}).mockResolvedValueOnce(ready).mockResolvedValueOnce({...ready,phase:'running'}).mockResolvedValueOnce({...ready,phase:'complete',counts:{pending:0,done:3,skipped:0,failed:0}});
 const save=vi.fn();const client=new BundleOperationClient(post,save);
 await client.prepare('orders','request-key');expect(post.mock.calls.map(c=>c[0])).toEqual(['bundles/done-prepare','bundles/done-prepare']);
 await Promise.all([client.run(),client.run()]);expect(post.mock.calls.filter(c=>c[0]==='bundles/done-run')).toHaveLength(2);
 expect(client.reference?.view?.counts.done).toBe(3);expect(save).toHaveBeenCalled();
});
it('persists an unknown acknowledgement and reconciles before explicitly resuming',async()=>{
 const post=vi.fn().mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({...ready,phase:'running'}).mockResolvedValueOnce({...ready,phase:'complete'});
 const client=new BundleOperationClient(post,vi.fn());await client.prepare('orders','key');await expect(client.run()).rejects.toThrow('Connection lost');
 expect(client.reference?.unknown).toBe(true);expect(post).toHaveBeenCalledTimes(2);
 await client.reconcile();expect(post.mock.calls[2][0]).toBe('bundles/done-status');expect(post).toHaveBeenCalledTimes(3);
 await client.run();expect(post.mock.calls[3][0]).toBe('bundles/done-run');
});
it('restores prepare request identity and only retries the failed remainder',async()=>{
 const post=vi.fn().mockRejectedValueOnce(new Error('Lost prepare')).mockResolvedValueOnce({...ready,phase:'complete',retryable:true});
 const client=new BundleOperationClient(post,vi.fn());await expect(client.prepare('orders','durable-key')).rejects.toThrow();
 const resumed=new BundleOperationClient(post,vi.fn(),client.reference);await resumed.reconcile();expect(post.mock.calls[1]).toEqual(['bundles/done-prepare',{bundle:'orders',requestId:'durable-key'}]);
 post.mockResolvedValueOnce({...ready,phase:'running'}).mockResolvedValueOnce({...ready,phase:'complete'});
 await resumed.run(true);expect(post.mock.calls[2][1]).toEqual({operationId:'opaque-id',retry:true});expect(post.mock.calls[3][1]).toEqual({operationId:'opaque-id'});
});
it('keeps cancellation lifecycle on the same controller after dismissing a result',async()=>{
 const post=vi.fn().mockResolvedValueOnce({...ready,phase:'complete'}).mockResolvedValueOnce(ready);const client=new BundleOperationClient(post,vi.fn());await client.prepare('orders','first');expect(client.clear()).toBe(true);expect(client.reference).toBeNull();client.stop();await client.prepare('orders','second');expect(post).toHaveBeenCalledTimes(1);
});
