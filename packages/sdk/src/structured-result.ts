import {SdkError, type Snapshot} from "./reducer.js";
import {schemaValidator,type JsonSchema} from "./schema.js";
import type {ValidateFunction} from "ajv";

export interface ResultFormat {type:"json";requestId:string;schema?:JsonSchema;validation?:"sdk"|"native"}
export interface ResultRequest extends ResultFormat {baselineMessageIds:string[]}
const validators=new WeakMap<ResultRequest,ValidateFunction>();
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
  if(!Array.isArray(baselineMessageIds) || baselineMessageIds.length>10000 || baselineMessageIds.some(id=>typeof id!=="string" || id.length>512)) throw new SdkError("invalid-result-format","Invalid result baseline message identities.");
  if(format.validation!==undefined && !["sdk","native"].includes(format.validation)) throw new SdkError("invalid-result-format","Unknown validation mode.");
  if(format.validation==="native") throw new SdkError("unsupported-native-schema","No verified CLI native JSON Schema generation path is available.");
  const request:ResultRequest={type:"json",requestId:format.requestId,baselineMessageIds:[...baselineMessageIds]};
  if(format.schema!==undefined) {
    const compiled=schemaValidator(format.schema);request.schema=compiled.schema;request.validation="sdk";validators.set(request,compiled.validate);
  }
  return request;
}

export function resultPrompt(prompt:string,request:ResultRequest|undefined):string {
  if(!request) return prompt;
  return prompt+"\n\nReturn your final answer as one JSON value without Markdown fences."+
    (request.schema!==undefined?"\nThe final answer must satisfy this JSON Schema (SDK validates the result):\n"+JSON.stringify(request.schema):"");
}

export function structuredResult(request:ResultRequest,snapshot:Snapshot):StructuredResult {
  const base:StructuredResult={type:"json",requestId:request.requestId,sessionId:snapshot.sessionId,executionId:snapshot.executionId,state:"pending",validation:request.schema!==undefined?"sdk-schema":"json"};
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
  try {
    const value=JSON.parse(candidate.text);
    const validate=validators.get(request);
    if(validate && !validate(value)) return {...base,state:"schema-mismatch",errors:validate.errors?.slice(0,32).map(error=>({path:error.instancePath,keyword:error.keyword,message:error.message??"Schema mismatch"}))};
    return {...base,state:"ready",value};
  }
  catch {return {...base,state:"invalid-json",errors:[{path:"",keyword:"parse",message:"Final answer is not a complete JSON value."}]};}
}
