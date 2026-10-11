import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createClient} from '@cline-cli-sdk/sdk';

const port = Number(process.env.CLINE_CHAT_PORT ?? 4174);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid CLINE_CHAT_PORT');
let client, preflight = null, generation = 0, unsubscribe;
let busy = false, refreshing = false, launchReserved = false;
const streams = new Set();
const requests = new Map();
const state = () => ({generation, preflight, busy:busy||refreshing, launchReserved, snapshot:client?.snapshot() ?? null, capabilities:client?.capabilities() ?? null});
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
    client?.close();
    client = createClient({mode:'live', connection:{host:input.host,cliPath:input.cliPath || undefined,
      remoteRoot:input.remoteRoot || undefined,identityFile:input.identityFile || undefined}});
    if(process.env.CLINE_CHAT_DIAGNOSTICS)await client.startDiagnostics({directory:process.env.CLINE_CHAT_DIAGNOSTICS});
    generation++; watch(); preflight = await client.connect();
  } else if (action === 'start') {
    if (!client || !preflight?.ready) throw problem('not-ready','연결 설정을 확인하세요.');
    launchReserved=true;
    try {await client.start({cwd:input.cwd,dataDir:input.dataDir || undefined,prompt:input.prompt,terminalMode:'tui'});}
    catch(error) {
      // Only documented pre-launch validation errors prove no remote write occurred.
      if(['invalid-task','unsupported-profile','prerequisites-unavailable','not-connected'].includes(error.code)) {
        launchReserved=false;error.notSubmitted=true;
      }
      throw error;
    }
    await client.refresh();
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
  const binding = JSON.stringify([action,input.generation,input.host,input.cliPath,input.remoteRoot,input.identityFile,input.cwd,input.dataDir,input.prompt,input.sessionId,input.executionId,input.revision,input.text,input.interactionId,input.answer]);
  const previous = requests.get(input.requestId);
  if (previous) {
    if (previous.binding !== binding) throw problem('request-conflict','이미 다른 내용에 사용된 요청입니다.');
    return previous.promise;
  }
  if (input.generation !== generation) throw problem('selection-changed','대화 상태가 변경되었습니다.');
  if (busy || refreshing) throw problem('operation-busy','진행 중인 상태 확인·전송이 있습니다.');
  if (requests.size >= 256) throw problem('request-limit','요청 보관 한도에 도달했습니다. 서버를 재시작하고 원격 실행을 확인하세요.');
  busy = true;
  const promise = Promise.resolve().then(() => perform(action,input)).finally(() => {busy=false;publish();});
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
    if (request.method === 'POST' && ['/api/connect','/api/start','/api/message','/api/respond'].includes(path)) {
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
  try {await client.refresh();} catch {} finally {refreshing=false;publish();}
},1000);
server.listen(port,'127.0.0.1',() => console.log(`Cline chat: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => {
  clearInterval(timer);unsubscribe?.();client?.close();for(const stream of streams) stream.end();server.close();
});
