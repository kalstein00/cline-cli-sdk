import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createClient} from '@cline-cli-sdk/sdk';

const port = Number(process.env.CLINE_CHAT_PORT ?? 4174);
const serverId=randomUUID();
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid CLINE_CHAT_PORT');
let client, preflight = null, generation = 0, unsubscribe;
let busy = false, refreshing = false, launchReserved = false;
let refreshTask;
let connectionOptions, selectedId = null, executions = [];
const titles = new Map();
const streams = new Set();
const requests = new Map();
function state() {
  const snapshot=client?.snapshot() ?? null;
  if(snapshot?.executionId) {
    selectedId=snapshot.executionId;
    const item=executions.find(e=>e.executionId===selectedId);
    if(item && snapshot.sessionId)item.sessionId=snapshot.sessionId;
    const title=snapshot.messages.find(m=>m.role==='user')?.text;
    if(title)titles.set(snapshot.sessionId ?? selectedId,title.slice(0,80));
  }
  return {serverId,generation,preflight,busy:busy||refreshing,launchReserved,selectedId,
    executions:executions.map(e=>({...e,title:(e.kind==='history'?'저장 기록 · ':'CLI 실행 · ')+(titles.get(e.sessionId ?? e.executionId) ?? e.sessionId ?? e.executionId)})),snapshot,capabilities:client?.capabilities() ?? null};
}
async function listExecutions(){executions=await client.listManagedExecutions();}
function currentExecution(executionId) {
  const seen=new Set();let run=executions.find(e=>e.executionId===executionId);
  if(!run)throw problem('unknown-execution','관리 실행 목록을 갱신하세요.');
  while(run.supersededBy){
    if(seen.has(run.executionId))throw problem('continuation-unconfirmed','재개 연결 관계를 확인할 수 없습니다. 목록을 갱신하세요.');
    seen.add(run.executionId);
    const next=executions.find(e=>e.executionId===run.supersededBy);
    if(!next || !run.sessionId || next.sessionId!==run.sessionId || next.remoteRoot!==run.remoteRoot)
      throw problem('continuation-unconfirmed','이미 재개된 대화입니다. 이어지는 실행을 확인할 수 없어 입력을 차단합니다. 목록을 갱신하세요.');
    run=next;
  }
  return run.executionId;
}
function guardSelection() {
  const snapshot=client?.snapshot();
  if(snapshot?.remoteObservation?.launchState==='unknown')throw problem('delivery-pending','실행 생성 여부를 먼저 확인하세요. 자동으로 새 실행을 만들지 않습니다.');
  if(snapshot?.inputControl?.current===false||(launchReserved&&!snapshot?.executionId)||[snapshot?.response,snapshot?.messageDelivery,snapshot?.resume].some(d=>['submitting','delivery-unknown'].includes(d?.state)))
    throw problem('delivery-pending','진행 중이거나 전달 여부가 불명인 요청을 먼저 확인하세요.');
}
async function selectClient(executionId=null) {
  guardSelection();
  if(executionId && client.snapshot().executionId===executionId){await client.refresh();return;}
  unsubscribe?.();client?.close();selectedId=executionId;launchReserved=false;
  client=createClient({mode:'live',connection:connectionOptions});generation++;watch();
  preflight=await client.connect();
  if(executionId)await client.attach(executionId);
  await listExecutions();
}
const publish = () => {
  const packet = `data: ${JSON.stringify(state())}\n\n`;
  for (const response of streams) response.write(packet);
};
function watch() {
  unsubscribe?.();
  const selected = client;
  unsubscribe = client.subscribe(() => queueMicrotask(() => {if (selected === client) publish();}));
}
const problem = (code, message) => Object.assign(new Error(message), {code,notSubmitted:true});
async function perform(action, input) {
  if (action === 'connect') {
    if (launchReserved || client?.snapshot().executionId) throw problem('execution-selected','현재 실행을 유지하고 있습니다. 새 연결로 전송 결과를 덮어쓸 수 없습니다.');
    connectionOptions={host:input.host,cliPath:input.cliPath || undefined,
      remoteRoot:input.remoteRoot || undefined,identityFile:input.identityFile || undefined,
      storageMode:input.storageMode ?? 'native',sessionDirectory:input.sessionDirectory || undefined};
    await selectClient();
    if(input.executionId && executions.some(e=>e.executionId===input.executionId)){selectedId=input.executionId;selectedId=currentExecution(input.executionId);await client.attach(selectedId);}
    if(process.env.CLINE_CHAT_DIAGNOSTICS)await client.startDiagnostics({directory:process.env.CLINE_CHAT_DIAGNOSTICS});
  } else if(action==='new'||action==='select') {
    if(!connectionOptions)throw problem('not-ready','연결 설정을 확인하세요.');
    if(action==='select'&&!executions.some(e=>e.executionId===input.executionId))throw problem('unknown-execution','관리 실행 목록을 갱신하세요.');
    await selectClient(action==='select'?input.executionId:null);
  } else if(action==='list') {
    if(!client)throw problem('not-ready','연결 설정을 확인하세요.');
    await listExecutions();
  } else if(action==='disconnect') {
    if(!client)throw problem('not-ready','연결 설정을 확인하세요.');
    client.disconnect();
  } else if(action==='reconnect') {
    if(!client)throw problem('not-ready','연결 설정을 확인하세요.');
    preflight=await client.connect();
    if(selectedId)await client.attach(selectedId);
    await listExecutions();
  } else if(action==='reconfirm') {
    if(!client)throw problem('not-ready','연결 설정을 확인하세요.');
    await client.reconfirmDelivery();
  } else if(action==='stop') {
    if(!client || client.snapshot().executionId!==input.executionId || client.snapshot().sessionId!==input.sessionId)throw problem('selection-changed','현재 선택한 실행을 중단하세요.');
    try{await client.stop({executionId:input.executionId,requestId:input.requestId});}catch(error){if(['wrong-stop-target','invalid-stop-request','not-connected','execution-not-running','stop-already-requested'].includes(error.code))error.notSubmitted=true;throw error;}
  } else if(action==='resume') {
    if(!client || client.snapshot().sessionId!==input.sessionId || client.snapshot().executionId!==input.executionId || !client.capabilities().resume)throw problem('resume-unconfirmed','현재 대화의 종료가 확인되어야 재개할 수 있습니다.');
    try{await client.resume({executionId:input.executionId,requestId:input.requestId,prompt:input.text});}catch(error){if(['invalid-resume','resume-already-requested','resume-unconfirmed','input-control-unavailable','not-connected','unsupported-json-resume','cli-option-unavailable'].includes(error.code))error.notSubmitted=true;throw error;}
    await listExecutions();
  } else if (action === 'start') {
    if (!client || !preflight?.ready) throw problem('not-ready','연결 설정을 확인하세요.');
    if(selectedId)throw problem('execution-selected','선택한 실행의 전체 상태를 확인하세요. 새 대화 버튼으로 새 요청을 시작하세요.');
    launchReserved=true;
    try {await client.start({cwd:input.cwd,dataDir:connectionOptions.storageMode==='native'?undefined:input.dataDir || undefined,prompt:input.prompt,terminalMode:'tui'});}
    catch(error) {
      // Only documented pre-launch validation errors prove no remote write occurred.
      if(error.notSubmitted===true || ['invalid-task','unsupported-profile','prerequisites-unavailable','not-connected','cli-option-unavailable'].includes(error.code)) {
        launchReserved=false;error.notSubmitted=true;
      }
      throw error;
    }
    await client.refresh();
    await listExecutions();
  } else if (action === 'respond') {
    if(!client)throw problem('not-ready','연결 설정을 확인하세요.');
    try{await client.respond({sessionId:input.sessionId,executionId:input.executionId,interactionId:input.interactionId,revision:input.revision,requestId:input.requestId,answer:input.answer});}
    catch(error){
      if(['invalid-response','invalid-request-id','response-target-mismatch','stale-interaction','stale-revision','unsupported-answer','interaction-unavailable','history-unconfirmed','stop-in-progress','not-connected','execution-unconfirmed','response-busy','response-request-limit','unsupported-json-input'].includes(error.code) || (client.snapshot().response?.requestId===input.requestId && client.snapshot().response.state==='not-submitted'))error.notSubmitted=true;
      throw error;
    }
  } else if (action === 'message') {
    if(!client)throw problem('not-ready','연결 설정을 확인하세요.');
    await client.sendMessage({sessionId:input.sessionId,executionId:input.executionId,revision:input.revision,requestId:input.requestId,text:input.text});
  } else throw problem('unknown-action','지원하지 않는 행동입니다.');
  return state();
}
function mutate(action, input) {
  if (!input || typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId))
    throw problem('invalid-request','요청 식별자가 필요합니다.');
  const binding = JSON.stringify([action,input.generation,input.host,input.cliPath,input.remoteRoot,input.identityFile,input.storageMode,input.sessionDirectory,input.cwd,input.dataDir,input.prompt,input.sessionId,input.executionId,input.revision,input.text,input.interactionId,input.answer]);
  const previous = requests.get(input.requestId);
  if (previous) {
    if (previous.binding !== binding) throw problem('request-conflict','이미 다른 내용에 사용된 요청입니다.');
    return previous.promise;
  }
  if (input.generation !== generation) throw problem('selection-changed','대화 상태가 변경되었습니다.');
  if(input.serverId!==serverId)throw problem('server-changed','서버가 재시작되었습니다. 현재 연결과 실행을 확인하세요.');
  if (busy) throw problem('operation-busy','진행 중인 전송이 있습니다.');
  if (requests.size >= 256) throw problem('request-limit','요청 보관 한도에 도달했습니다. 서버를 재시작하고 원격 실행을 확인하세요.');
  const fingerprint=s=>JSON.stringify([s?.sessionId,s?.executionId,s?.interaction]);
  const accepted=client?.snapshot();
  const responseTarget=action==='respond' && accepted?.revision===input.revision ? fingerprint(accepted) : null;
  busy = true;
  const promise = Promise.resolve().then(async () => {
    await refreshTask;
    let prepared=input;
    if(responseTarget!==null) {
      const latest=client.snapshot();
      if(fingerprint(latest)!==responseTarget)throw problem('stale-interaction','대기 중인 질문이 변경되었습니다. 현재 질문을 확인하세요.');
      prepared={...input,revision:latest.revision};
    }
    return perform(action,prepared);
  }).finally(() => {busy=false;publish();});
  requests.set(input.requestId,{binding,promise});
  return promise;
}
const assets = new Map([['/','index.html'],['/app.mjs','app.mjs'],['/style.css','style.css']]);
const types = {html:'text/html',mjs:'text/javascript',css:'text/css'};
function json(response, status, value) {
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(value));
}
const server = createServer(async (request,response) => {
  try {
    const allowed = new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
    if (!allowed.has(request.headers.host)) {json(response,403,{error:'local-host-only'});return;}
    const path = new URL(request.url,`http://127.0.0.1:${port}`).pathname;
    if (request.method === 'GET' && assets.has(path)) {
      const file = assets.get(path);
      response.writeHead(200,{'Content-Type':`${types[file.split('.').at(-1)]}; charset=utf-8`,
        'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
      response.end(await readFile(new URL(file,import.meta.url)));return;
    }
    if (request.method === 'GET' && path === '/api/state') {json(response,200,state());return;}
    if (request.method === 'GET' && path === '/api/events') {
      response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store',Connection:'keep-alive'});
      streams.add(response);response.write(`data: ${JSON.stringify(state())}\n\n`);
      request.on('close',() => streams.delete(response));return;
    }
    if (request.method === 'POST' && ['/api/connect','/api/start','/api/message','/api/respond','/api/new','/api/select','/api/list','/api/disconnect','/api/reconnect','/api/reconfirm','/api/stop','/api/resume'].includes(path)) {
      const origin = request.headers.origin;
      if ((origin && !allowed.has(origin.replace(/^http:\/\//,''))) || request.headers['content-type'] !== 'application/json') {
        json(response,403,{error:'local-json-only'});return;
      }
      let bytes=0; const chunks=[];
      for await (const chunk of request) {
        bytes+=chunk.length;if(bytes>1048576){json(response,413,{error:'request-too-large',notSubmitted:true});return;}chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await mutate(path.slice(5),input);
      json(response,200,state());return;
    }
    json(response,404,{error:'not-found'});
  } catch (error) {
    json(response,400,{...state(),error:error.code ?? 'invalid-request',message:error.message,
      notSubmitted:error.notSubmitted===true});
  }
});
const timer = setInterval(async () => {
  if (!client?.snapshot().executionId || busy || refreshing || client.snapshot().connection !== 'connected') return;
  refreshing=true;
  refreshTask=client.refresh().catch(()=>{});
  try {await refreshTask;} finally {refreshing=false;refreshTask=null;publish();}
},200);
server.listen(port,'127.0.0.1',() => console.log(`Cline chat: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => {
  clearInterval(timer);unsubscribe?.();client?.close();for(const stream of streams) stream.end();server.close();
});
