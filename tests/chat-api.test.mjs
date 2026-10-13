import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

test('chat HTTP API exposes saved history and refuses all remote input paths', {timeout:15000}, async t=>{
 const port=4334,base='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['tests/support/chat-browser.mjs'],{env:{...process.env,CLINE_CHAT_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(()=>server.kill());
 await new Promise((resolve,reject)=>{server.stdout.on('data',chunk=>{if(chunk.toString().includes(base))resolve();});server.once('exit',code=>reject(Error('Server exited '+code)));});
 const state=()=>fetch(base+'/api/state').then(r=>r.json());
 const invoke=async(action,fields={})=>{
  let before=await state();
  for(let i=0;before.busy&&i<20;i++){await new Promise(r=>setTimeout(r,25));before=await state();}
  return fetch(base+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverId:before.serverId,generation:before.generation,requestId:randomUUID(),...fields})}).then(r=>r.json());
 };
 const connected=await invoke('connect',{host:'fixture',cwd:'/work'});assert.equal(connected.preflight.ready,true);
 const history=await invoke('select',{executionId:'history:saved-chat'});assert.equal(history.snapshot.messages[0].text,'Prior conversation');
 for(const action of ['message','respond','stop']){
  const result=await invoke(action,{executionId:history.snapshot.executionId,sessionId:history.snapshot.sessionId,text:'never send',answer:'Approve'});
  assert.equal(result.error,'remote-input-disabled');assert.equal(result.notSubmitted,true);
 }
 await invoke('new');const launched=await invoke('start',{cwd:'/work',prompt:'First request'});
 assert.equal(launched.snapshot.remoteObservation.launchState,'tmux-created');assert.equal(launched.snapshot.remoteObservation.paneAlive,true);
 assert.equal(launched.snapshot.messageInput.ready,false);assert.equal(launched.capabilities.stop,false);
 assert.ok(launched.executions.some(e=>e.kind==='tmux'));assert.ok(launched.executions.some(e=>e.kind==='history'));
 const before=launched.snapshot.executionId;await invoke('disconnect');const restored=await invoke('reconnect');assert.equal(restored.snapshot.executionId,before);
});
