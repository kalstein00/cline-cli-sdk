// Controlled external OpenSSH boundary. The installed SDK and browser app run unchanged.
import cp from 'node:child_process';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {pinned} from './remote.mjs';
const native = cp.spawn;
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
      result = {executionId, remoteRoot: '/fixture/control'};
    } else if (request.action === 'status') {
      const history = Buffer.from(JSON.stringify({version:1, sessionId:'chat-fixture-session', messages:[
        {id:'user-first',role:'user',content:[{type:'text',text:prompt}]},
        {id:'assistant-first',role:'assistant',content:[{type:'text',text:'CHAT_BROWSER_READY'}]},
      ]}));
      result = {executionId,sessionId:'chat-fixture-session',cursor:0,observations:[],
        history:{dataBase64:history.toString('base64'),sha256:createHash('sha256').update(history).digest('hex')},
        process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot-1'},alive:true,identityConfirmed:true,exitCode:null,manifestStatus:'pending'}};
    } else result = {error:'fixture-no-operation',message:'Unsupported controlled operation'};
    process.stdout.end(JSON.stringify(result));
    queueMicrotask(() => process.emit('close',0));
  });
  return process;
};
await import('../../examples/chat/server.mjs');
