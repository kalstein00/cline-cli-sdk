import {mkdir,mkdtemp,writeFile,appendFile,readFile,readdir,stat,unlink,rmdir} from "node:fs/promises";
import {resolve,join,dirname} from "node:path";
import {createHash} from "node:crypto";
import {SdkError,type Recording,type Observation,type SdkEvent,type Snapshot} from "./reducer.js";

export interface DiagnosticOptions { directory: string; maxBytes?: number; maxBundles?: number; retentionDays?: number }
export interface DiagnosticStatus {
  state: "inactive"|"collecting"|"stopped"|"limit-reached"|"failed";
  path: string|null; bytes: number; observations: number; truncated: boolean;
  maxBytes: number; maxBundles: number; retentionDays: number; failure: string|null;
}
export interface DiagnosticBundle {recording:Recording;comparison:{events:SdkEvent[];snapshot:Snapshot|null};metadata:any}
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const initial=():DiagnosticStatus=>({state:"inactive",path:null,bytes:0,observations:0,truncated:false,maxBytes:16*1024*1024,maxBundles:5,retentionDays:7,failure:null});
const projection=(s:Snapshot|null)=>s?(({mode,replay,...rest})=>rest)(s):null;
export function compareDiagnostic(bundle:DiagnosticBundle,events:SdkEvent[],snapshot:Snapshot) {
  let eventDifferences=0;
  for(let i=0;i<Math.max(events.length,bundle.comparison.events.length);i++)if(JSON.stringify(events[i])!==JSON.stringify(bundle.comparison.events[i]))eventDifferences++;
  const snapshotMatches=JSON.stringify(projection(snapshot))===JSON.stringify(projection(bundle.comparison.snapshot));
  return {matches:eventDifferences===0&&snapshotMatches,eventDifferences,snapshotMatches};
}
export function createDiagnosticCollector() {
  let status=initial();let queue=Promise.resolve();let lastSnapshot:Snapshot|null=null;
  let header:any=null;let startedAt="";
  const fail=(error:unknown)=>{status.state="failed";status.truncated=true;status.failure=(error as NodeJS.ErrnoException).code??"storage-failed";};
  const enqueue=(action:()=>Promise<void>)=>{queue=queue.then(action).catch(fail);};
  return {
    status:()=>structuredClone(status),
    async start(options:DiagnosticOptions) {
      if(status.state==="collecting")throw new SdkError("diagnostics-active","Stop the current diagnostic collection first.");
      const limits={maxBytes:options.maxBytes??16*1024*1024,maxBundles:options.maxBundles??5,retentionDays:options.retentionDays??7};
      if(!options.directory||!Number.isInteger(limits.maxBytes)||limits.maxBytes<4096||limits.maxBytes>256*1024*1024||!Number.isInteger(limits.maxBundles)||limits.maxBundles<1||limits.maxBundles>50||!Number.isInteger(limits.retentionDays)||limits.retentionDays<1||limits.retentionDays>90)throw new SdkError("invalid-diagnostics-options","Choose a directory, 4 KiB–256 MiB, 1–50 bundles and 1–90 retention days.");
      status={...initial(),...limits,state:"collecting"};lastSnapshot=null;queue=Promise.resolve();startedAt=new Date().toISOString();
      header={format:"cline-cli-sdk-diagnostic",schemaVersion:2,sdkVersion:"0.1.0",adapterVersion:1,startedAt,limits,exclusions:["SSH configuration/key files","provider/settings files","history system_prompt/provider/model/thinking/metrics fields"],contentReview:"Conversation, tool arguments, PTY and responses can contain sensitive content; review before export."};
      try {
        const root=resolve(options.directory);await mkdir(root,{recursive:true,mode:0o700});
        const owned=[];
        for(const name of await readdir(root)) {
          if(!/^cline-sdk-diag-[A-Za-z0-9]+$/.test(name))continue;
          const path=join(root,name);const info=await stat(path);if(!info.isDirectory())continue;
          try{const m=JSON.parse(await readFile(join(path,"manifest.json"),"utf8"));if(m.format===header.format&&m.stoppedAt)owned.push({path,time:Date.parse(m.startedAt)});}catch{}
        }
        owned.sort((a,b)=>b.time-a.time);
        for(const [index,item] of owned.entries())if(index>=limits.maxBundles-1||Date.now()-item.time>limits.retentionDays*86400000) {
          if(dirname(item.path)!==root)throw new Error("retention-path-outside-directory");
          // Remove only the two SDK-owned files; unknown user files prevent rmdir.
          await unlink(join(item.path,"observations.ndjson")).catch(()=>{});await unlink(join(item.path,"manifest.json")).catch(()=>{});await rmdir(item.path).catch(()=>{});
        }
        status.path=await mkdtemp(join(root,"cline-sdk-diag-"));
        await writeFile(join(status.path,"observations.ndjson"),"",{mode:0o600,flag:"wx"});
        await writeFile(join(status.path,"manifest.json"),JSON.stringify({...header,status}),{mode:0o600,flag:"wx"});
      }catch(error){fail(error);}
      return structuredClone(status);
    },
    capture(observation:Observation,events:SdkEvent[],snapshot:Snapshot) {
      if(status.state!=="collecting")return;
      const obs=structuredClone(observation);
      if(obs.kind==="history") {
        try {
          const original=JSON.parse(Buffer.from(obs.dataBase64,"base64").toString("utf8"));
          const filtered={version:original.version,sessionId:original.sessionId,messages:original.messages?.map((m:any)=>({id:m.id,role:m.role,content:m.content?.filter((p:any)=>["text","tool_use","tool_result"].includes(p.type)).map((p:any)=>p.type==="text"?{type:p.type,text:p.text}:p.type==="tool_use"?{type:p.type,id:p.id,name:p.name,input:p.input}:{type:p.type,tool_use_id:p.tool_use_id,content:p.content,is_error:p.is_error})}))};
          obs.dataBase64=Buffer.from(JSON.stringify(filtered)).toString("base64");
        }catch {obs.dataBase64=Buffer.from("{invalid-history-observation").toString("base64");}
      }
      const line=JSON.stringify({observation:obs,sha256:sha(JSON.stringify(obs)),comparison:{events,snapshot}})+"\n";
      const bytes=Buffer.byteLength(line);
      if(status.bytes+bytes>status.maxBytes){status.state="limit-reached";status.truncated=true;return;}
      status.bytes+=bytes;status.observations++;lastSnapshot=structuredClone(snapshot);
      const path=status.path!;enqueue(async()=>{await appendFile(join(path,"observations.ndjson"),line);});
    },
    async stop() {
      if(status.state==="inactive")return structuredClone(status);
      if(status.state==="collecting")status.state="stopped";
      await queue;
      if(status.path)try{await writeFile(join(status.path,"manifest.json"),JSON.stringify({...header,stoppedAt:new Date().toISOString(),status,comparisonSnapshot:lastSnapshot}),{mode:0o600});}catch(error){fail(error);}
      return structuredClone(status);
    }
  };
}
export async function readDiagnostic(path:string):Promise<DiagnosticBundle> {
  const root=resolve(path);const metadata=JSON.parse(await readFile(join(root,"manifest.json"),"utf8"));
  if(metadata.format!=="cline-cli-sdk-diagnostic"||metadata.schemaVersion!==2)throw new SdkError("invalid-diagnostic","Unknown diagnostic format.");
  const file=join(root,"observations.ndjson");if((await stat(file)).size>256*1024*1024)throw new SdkError("diagnostic-read-limit","Diagnostic file exceeds finite read limit.");
  const observations:Observation[]=[];const events:SdkEvent[]=[];
  const content=await readFile(file,"utf8");let truncated=!!metadata.status.truncated;
  for(const line of content.split("\n")){if(!line)continue;let entry;try{entry=JSON.parse(line);}catch{truncated=true;break;}if(entry.sha256!==sha(JSON.stringify(entry.observation)))throw new SdkError("diagnostic-hash-mismatch","A raw observation changed after collection.");observations.push(entry.observation);events.push(...entry.comparison.events);}
  return {recording:{schemaVersion:2,interpretation:"live",cli:{name:"cline",version:"unknown",profile:"unknown"},terminal:{rows:40,cols:120},sessionId:null,executionId:null,observations,provenance:{source:"SDK diagnostics",sourceSha256:sha(content),review:metadata.contentReview,transformations:metadata.exclusions,complete:!!metadata.stoppedAt&&!truncated,truncated}},comparison:{events,snapshot:metadata.comparisonSnapshot},metadata};
}
