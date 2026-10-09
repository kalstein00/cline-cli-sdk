import type {MessageContent} from "./reducer.js";

export interface JsonOutputState {
  state:"observing" | "completed" | "failed" | "unsupported" | "incomplete";
  warning:string | null;
  finalText?:string;
  lastContent?:MessageContent;
  lastEvent?:string;
  stderr?:string;
}

/** The pinned CLI emits newline-delimited agent_event/run_result records. */
export function jsonOutputParser() {
  const decoder=new TextDecoder("utf-8",{fatal:true});
  const errorDecoder=new TextDecoder("utf-8");
  let buffer="";
  let closed=false;
  let state:JsonOutputState={state:"observing",warning:null};
  const fault=(message:string)=>{state={...state,state:"incomplete",warning:message};};
  const record=(raw:unknown)=>{
    if (!raw || typeof raw!=="object" || Array.isArray(raw)) {fault("Invalid JSON record envelope.");return;}
    const value=raw as Record<string,any>;
    const unsafe=state.state==="incomplete" || state.state==="unsupported";
    if(value.type==="run_result") {
      if(typeof value.text!=="string" || typeof value.finishReason!=="string") {fault("Invalid run_result.");return;}
      state={...state,lastEvent:value.type,finalText:value.text,state:unsafe?state.state:value.finishReason==="completed"?"completed":"failed"};
    } else if(value.type==="agent_event") {
      const event=value.event;
      if(!event || typeof event.type!=="string") {fault("Invalid agent event.");return;}
      state={...state,lastEvent:event.type};
      if(event.type==="content_start") {
        if(event.contentType==="reasoning") {
          if(event.redacted) state.lastContent={type:"redacted_thinking"};
          else if(typeof event.reasoning==="string") state.lastContent={type:"thinking",thinking:event.reasoning};
          else fault("Invalid exposed reasoning.");
        } else if(event.contentType==="text" && typeof event.text==="string") state.lastContent={type:"text",text:event.text};
        else if(event.contentType==="tool") {
          if(event.toolName==="ask_question") state={...state,state:"unsupported",warning:"JSON questions have no verified response path."};
        } else fault("Unsupported content event.");
      } else if(event.type==="error" && !event.recoverable) state={...state,state:"failed",warning:"CLI reported a non-recoverable agent error."};
      else if(!["content_end","done","error","notice","iteration_start","iteration_end","usage"].includes(event.type)) fault("Unsupported agent event: "+event.type);
    } else if(["run_start","hook_event","team_event","team_restored","run_abort_requested"].includes(value.type)) state={...state,lastEvent:value.type};
    else if(value.type==="run_aborted") state={...state,state:"failed",lastEvent:value.type};
    else fault("Unsupported JSON record: "+String(value.type));
  };
  return {
    state:()=>structuredClone(state),
    gap:()=>fault("JSON observation gap; replay or final history reconciliation is required."),
    feed(bytes:Uint8Array,channel:"stdout"|"stderr") {
      if(closed) {fault("Output arrived after stream closure.");return;}
      if(channel==="stderr") {state.stderr=((state.stderr??"")+errorDecoder.decode(bytes,{stream:true})).slice(-2000);return;}
      try {buffer+=decoder.decode(bytes,{stream:true});} catch {fault("Invalid UTF-8 in JSON output.");buffer="";return;}
      while(buffer.includes("\n")) {
        const newline=buffer.indexOf("\n"); const line=buffer.slice(0,newline).trim(); buffer=buffer.slice(newline+1);
        if(Buffer.byteLength(line)>128*1024) {fault("JSON record exceeded 128 KiB.");continue;}
        if(!line) continue;
        try {record(JSON.parse(line));} catch {fault("Malformed JSON output record.");}
      }
      if(Buffer.byteLength(buffer)>128*1024) {fault("JSON record exceeded 128 KiB.");buffer="";}
    },
    end() {
      if(closed) return;
      closed=true;
      try {buffer+=decoder.decode();} catch {fault("Truncated UTF-8 output.");}
      if(buffer.trim()) fault("Truncated JSON output record.");
    },
  };
}
