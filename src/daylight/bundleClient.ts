import type { BundleId } from '../lib/bundles';
import { postInbox } from '../lib/attachmentClient';
export interface BundleOperationView {
 id: string; bundle: BundleId; phase: 'preparing'|'ready'|'running'|'complete'; total: number; unreadCount: number;
 counts: {pending:number;done:number;skipped:number;failed:number}; retryable:boolean;
}
export interface OperationReference {bundle:BundleId;requestId:string;operationId?:string;view?:BundleOperationView;unknown?:boolean;}
/** One bounded request at a time. Unknown mutation acknowledgements always pause for reconciliation. */
export class BundleOperationClient {
 reference: OperationReference | null;
 private locked = false;
 private stopped = false;
 constructor(private post: typeof postInbox = postInbox, private save: (value:OperationReference)=>void, reference:OperationReference|null=null) { this.reference=reference; }
 stop(){this.stopped=true;}
 clear(){if(this.locked)return false;this.reference=null;return true;}
 private publish(value:OperationReference){this.reference=value;this.save(value);}
 private async request(path:string,body:unknown){
  try {const view=await this.post<BundleOperationView>(path,body);this.publish({...this.reference!,view,operationId:view.id,unknown:false});return view;}
  catch(error){this.publish({...this.reference!,unknown:true});throw error;}
 }
 async prepare(bundle:BundleId,requestId:string){
  if(this.locked||this.stopped)return;this.locked=true;
  try {
   this.publish(this.reference??{bundle,requestId});
   let view:BundleOperationView;
   do {view=await this.request('bundles/done-prepare',{bundle:this.reference!.bundle,requestId:this.reference!.requestId});} while(view.phase==='preparing'&&!this.stopped);
  } finally {this.locked=false;}
 }
 async reconcile(){
  if(this.locked||this.stopped||!this.reference)return;
  if(!this.reference.operationId){await this.prepare(this.reference.bundle,this.reference.requestId);return;}
  this.locked=true;
  try {await this.request('bundles/done-status',{operationId:this.reference.operationId});}finally{this.locked=false;}
 }
 async run(retry=false){
  if(this.locked||this.stopped||!this.reference?.operationId)return;
  if(this.reference.unknown)throw new Error('Check operation status before continuing.');
  if(this.reference.view?.phase==='complete'&&!retry)return;
  this.locked=true;
  try {
   let view:BundleOperationView;
   do {view=await this.request('bundles/done-run',{operationId:this.reference!.operationId,...(retry?{retry:true}:{})});retry=false;}while(view.phase==='running'&&!this.stopped);
  }finally{this.locked=false;}
 }
}
export function operationStorageKey(userId:string){return `daylight:bundle-operation:v1:${encodeURIComponent(userId)}`;}
export function readOperation(userId:string|null):OperationReference|null {
 if(!userId)return null;
 try {const value=JSON.parse(localStorage.getItem(operationStorageKey(userId))??'null');return value&&typeof value.requestId==='string'&&['orders','shipping','commissions','fans','promos','updates'].includes(value.bundle)?value:null;}catch{return null;}
}
