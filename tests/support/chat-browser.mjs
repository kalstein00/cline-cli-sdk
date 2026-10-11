// Controlled external OpenSSH boundary. The installed SDK and browser app run unchanged.
import cp from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {pinned} from './remote.mjs';
const composer=JSON.parse(await readFile(new URL('../../fixtures/resume/restored-composer.json',import.meta.url)));
const native = cp.spawn;
const fault = process.env.CLINE_CHAT_FAULT;
let executionId, prompt;
cp.spawn = (...args) => {
  if (!['ssh', 'ssh.exe'].includes(args[0])) return native(...args);
  const process = new EventEmitter();
  process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.kill = () => {};
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('finish', () => {
    const request = JSON.parse(input);
    let result;
    if (!request.action) result = pinned;
    else if (request.action === 'start') {
      executionId = request.executionId; prompt = request.prompt;
      result = {executionId:fault==='launch-identity'?'unexpected-execution':executionId, remoteRoot: '/fixture/control'};
    } else if (request.action === 'status') {
      const history = Buffer.from(JSON.stringify({version:1, sessionId:'chat-fixture-session', messages:[
        {id:'user-first',role:'user',content:[{type:'text',text:prompt}]},
        {id:'assistant-first',role:'assistant',content:[{type:'text',text:'CHAT_BROWSER_READY'}]},
      ]}));
      result = {executionId,sessionId:'chat-fixture-session',cursor:composer.observations.at(-1).seq,observations:['ready','busy'].includes(fault)?composer.observations.filter(o=>o.kind==='pty'&&o.seq>request.cursor):[],
        composerHash:['ready','busy'].includes(fault)?'controlled-composer':null,
        management:{phaseSupported:true,phase:{active:false},responseReservation:true},
        history:{dataBase64:history.toString('base64'),sha256:createHash('sha256').update(history).digest('hex')},
        process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot-1'},alive:true,identityConfirmed:true,exitCode:null,manifestStatus:fault==='ready'?'idle':'running',supervisorAlive:true,children:[],trackingError:null}};
    } else result = {error:'fixture-no-operation',message:'Unsupported controlled operation'};
    process.stdout.end(JSON.stringify(result));
    queueMicrotask(() => process.emit('close',0));
  });
  return process;
};
await import('../../examples/chat/server.mjs');
