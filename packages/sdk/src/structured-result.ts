import {SdkError, type Snapshot} from "./reducer.js";

export interface ResultFormat {type:"json";requestId:string}
export interface ResultRequest extends ResultFormat {baselineMessageIds:string[]}
export interface StructuredResult {
  type:"json";
  requestId:string;
  sessionId:string|null;
  executionId:string|null;
  state:"pending"|"ready"|"invalid-json"|"schema-mismatch"|"interrupted"|"unconfirmed";
  validation:"json"|"sdk-schema";
  messageId?:string;
  rawText?:string;
  value?:unknown;
  errors?:{path:string;keyword:string;message:string}[];
}

export function prepareResult(format:ResultFormat|undefined,baselineMessageIds:string[]=[]):ResultRequest|undefined {
  if(format===undefined) return undefined;
  if(!format || format.type!=="json" || typeof format.requestId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(format.requestId))
    throw new SdkError("invalid-result-format","JSON result requests require a bounded requestId.");
  return {type:"json",requestId:format.requestId,baselineMessageIds:[...baselineMessageIds]};
}

export function structuredResult(request:ResultRequest,snapshot:Snapshot):StructuredResult {
  const base:StructuredResult={type:"json",requestId:request.requestId,sessionId:snapshot.sessionId,executionId:snapshot.executionId,state:"pending",validation:"json"};
  let lastUser=-1;
  for(let index=snapshot.messages.length-1;index>=0;index--) if(snapshot.messages[index].role==="user" && !snapshot.messages[index].isToolResult) {lastUser=index;break;}
  const candidate=snapshot.messages.slice(lastUser+1).reverse().find(message=>message.role==="assistant" && message.text && !message.hasToolCalls && !request.baselineMessageIds.includes(message.id));
  if(candidate) {base.messageId=candidate.id;base.rawText=candidate.text;}
  if(snapshot.execution==="failed" || snapshot.execution==="stopped") return {...base,state:"interrupted"};
  if(!snapshot.historySync.current || snapshot.jsonOutput?.state==="incomplete" || snapshot.jsonOutput?.state==="unsupported") return {...base,state:"unconfirmed"};
  const process=snapshot.executionEvidence;
  const jsonFinal=snapshot.jsonOutput?.state==="completed" && candidate?.text===snapshot.jsonOutput.finalText;
  const idleAnswer=process?.alive && process.manifestStatus==="idle" && !!snapshot.composer && !snapshot.interaction;
  if(!candidate || !process?.identityConfirmed || !(snapshot.execution==="completed" || jsonFinal || idleAnswer)) return base;
  try {return {...base,state:"ready",value:JSON.parse(candidate.text)};}
  catch {return {...base,state:"invalid-json",errors:[{path:"",keyword:"parse",message:"Final answer is not a complete JSON value."}]};}
}
