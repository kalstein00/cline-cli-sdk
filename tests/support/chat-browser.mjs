// Controlled external OpenSSH boundary. The installed SDK and browser app run unchanged.
import cp from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {pinned} from './remote.mjs';
const composer=JSON.parse(await readFile(new URL('../../fixtures/resume/restored-composer.json',import.meta.url)));
const question=JSON.parse(await readFile(new URL('../../fixtures/text/tui-custom-response.json',import.meta.url)));
const approval=JSON.parse(await readFile(new URL('../../fixtures/chat/readiness.json',import.meta.url)));
const onboarding=JSON.parse(await readFile(new URL('../../fixtures/startup/provider-setup.json',import.meta.url)));
const streaming=JSON.parse(await readFile(new URL('../../fixtures/streaming/actual-tui-answer.json',import.meta.url)));
const native = cp.spawn;
const fault = process.env.CLINE_CHAT_FAULT;
let executionId, prompt;
let stopResult;
let messageRequest, messageRejected=false, messageResolution;
let resumeConflict=false;
let responseWrites=[],responsePosition=98,streamPhase=-1;
const runs=new Map();
const lineageIds=['run-11111111-1111-4111-8111-111111111111','run-22222222-2222-4222-8222-222222222222','run-33333333-3333-4333-8333-333333333333'];
if(fault==='resumed-lineage')for(const [i,id] of lineageIds.entries())runs.set(id,{prompt:'original conversation',sessionId:'chat-fixture-session',supersededBy:lineageIds[i+1]});
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
    if (!request.action) result = fault==='company' ? {...pinned,cliVersion:'company-build',cliHash:'a'.repeat(64)} : fault==='missing-options' ? {...pinned,cliFlags:['--cwd']} : fault==='no-tui' ? {...pinned,cliFlags:pinned.cliFlags.filter(flag=>flag!=='--tui')} : pinned;
    else if (request.action === 'start') {
      if(fault==='cwd-error' && request.cwd==='/missing'){
        process.stdout.end(JSON.stringify({error:'working-directory-not-found',message:'원격 작업 디렉터리가 없습니다.'}));queueMicrotask(()=>process.emit('close',0));return;
      }
      executionId = request.executionId; prompt = request.prompt;runs.set(executionId,{prompt,sessionId:'chat-fixture-session-'+runs.size});
      result = {executionId:fault==='launch-identity'?'unexpected-execution':executionId, remoteRoot: '/fixture/control'};
    } else if(request.action==='resume' && fault==='resume-conflict'){
      resumeConflict=true;const successor='run-33333333-3333-4333-8333-333333333333';runs.get(executionId).supersededBy=successor;runs.set(successor,{prompt,sessionId:'chat-fixture-session'});
      result={state:'not-submitted',executionId:request.newExecutionId,sessionId:'chat-fixture-session',promptDigest:createHash('sha256').update(request.prompt).digest('hex'),supersededBy:successor};
    } else if(request.action==='stop'){stopResult={executionId:request.executionId,requestId:request.requestId,state:fault==='stop-unknown'?'unknown':'confirmed',childrenVerified:fault!=='stop-unknown',trackedCount:1,remaining:[],reason:null,observedAt:new Date().toISOString()};result=stopResult;
    } else if(request.action==='list') {
      // Hold each captured answer frame until the consumer test has observed it.
      // The automatic post-start list enters phase 0; later explicit reads advance.
      if(fault==='streaming' && executionId)streamPhase++;
      result={executions:[...runs].map(([id,run])=>({executionId:id,remoteRoot:'/fixture/control',sessionId:run.sessionId,supersededBy:run.supersededBy,terminalMode:'tui',terminal:{rows:40,cols:120},cliHash:pinned.cliHash,alive:!run.supersededBy,identityConfirmed:true}))};
    } else if (request.action === 'reserve-message') {
      messageRequest=request;result={state:'reserved',fresh:true};
    } else if (request.action === 'respond' && fault==='message-rejected') {
      messageRejected=true;result={state:'queued'};
    } else if(request.action==='respond' && fault.startsWith('reply-')) {
      responseWrites.push(request);
      responsePosition=fault==='reply-text' ? request.inputType==='tui-navigation'?460:request.inputType==='tui-text'?1417:1487 : fault==='reply-approval'?400:1487;
      result={state:'queued'};
    } else if (request.action === 'settle-message' && fault==='message-rejected') {
      messageResolution='not-submitted';result={state:'not-submitted',executionId,sessionId:'chat-fixture-session',promptDigest:messageRequest.answerDigest};
    } else if (request.action === 'status') {
      if(['multi','resumed-lineage'].includes(fault)){executionId=request.executionId;prompt=runs.get(executionId)?.prompt;}
      const sid=fault==='multi'?runs.get(executionId)?.sessionId:'chat-fixture-session';
      const history = Buffer.from(JSON.stringify({version:1, sessionId:sid, messages:[
        {id:'user-first',role:'user',content:[{type:'text',text:prompt}]},
        {id:'assistant-first',role:'assistant',content:[{type:'text',text:'CHAT_BROWSER_READY'}]},
      ]}));
      result = {executionId,sessionId:sid,cursor:composer.observations.at(-1).seq,observations:['ready','busy','multi','company','message-rejected'].includes(fault)?composer.observations.filter(o=>o.kind==='pty'&&o.seq>request.cursor):[],
        composerHash:['ready','busy','multi','company','message-rejected'].includes(fault)?'controlled-composer':null,
        management:{phaseSupported:true,phase:{active:false},responseReservation:true},
        history:{dataBase64:history.toString('base64'),sha256:createHash('sha256').update(history).digest('hex')},
        process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot-1'},alive:true,identityConfirmed:true,exitCode:null,manifestStatus:['ready','multi','company','message-rejected'].includes(fault)?'idle':'running',supervisorAlive:true,children:[],trackingError:null}};
      if(messageRejected)result.requests=[{requestId:messageRequest.requestId,state:'rejected',resolution:messageResolution,message:true,binding:messageRequest,baselineMessageCount:2,baselineLastMessageId:'assistant-first',steps:[{index:0,state:'rejected'}]}];
      if(stopResult)Object.assign(result.process,{stop:stopResult,alive:stopResult.state!=='confirmed',exitCode:stopResult.state==='confirmed'?-15:null,manifestStatus:'cancelled',supervisorAlive:stopResult.state!=='confirmed',childrenVerified:stopResult.childrenVerified});
      if(fault==='resumed-lineage'){
       result.supersededBy=runs.get(executionId)?.supersededBy;
       result.observations=composer.observations.filter(o=>o.kind==='pty'&&o.seq>request.cursor);result.composerHash='controlled-composer';
       Object.assign(result.process,{alive:!result.supersededBy,exitCode:result.supersededBy?0:null,manifestStatus:result.supersededBy?'completed':'idle',supervisorAlive:!result.supersededBy,childrenVerified:true});
      }
      if(fault==='resume-conflict'){
       Object.assign(result.process,{alive:false,exitCode:0,manifestStatus:'completed',supervisorAlive:false,childrenVerified:true});
       if(resumeConflict)result.supersededBy=runs.get(executionId).supersededBy;
      }
    } else result = {error:'fixture-no-operation',message:'Unsupported controlled operation'};
    if(request.action==='status' && (['question','approval'].includes(fault)||fault.startsWith('reply-'))) {
      const record=['approval','reply-approval'].includes(fault)?approval:question;
      const end=responseWrites.length?responsePosition:record===question?98:record.observations.find(o=>o.kind==='response-input').seq-1;const rows=record.observations.filter(o=>o.seq<=end);
      result.sessionId=record.sessionId;result.cursor=end;result.modalHash='question-modal';result.composerHash=null;
      result.observations=rows.filter(o=>o.kind==='pty'&&o.seq>request.cursor);
      const raw=JSON.parse(Buffer.from(rows.filter(o=>o.kind==='history').at(-1).dataBase64,'base64'));result.sessionId=raw.sessionId;const first=raw.messages.find(m=>m.role==='user'&&m.content.some(p=>p.type==='text'));if(first)first.content.find(p=>p.type==='text').text=prompt;else raw.messages.unshift({id:'user-first',role:'user',content:[{type:'text',text:prompt}]});
      if(responseWrites.length) {
        const answer=fault==='reply-choice'?'BLUE':fault==='reply-text'?'2 custom identifier':Buffer.from(responseWrites[0].dataBase64,'base64').toString()==='y'?'Approve':'Deny';
        if(fault==='reply-choice')for(const m of raw.messages)for(const p of m.content)if(p.type==='tool_result')p.content=answer;
        if(fault==='reply-approval'){
          for(const m of raw.messages)for(const p of m.content)if(p.type==='tool_result'&&answer==='Deny'){p.content=[{type:'text',text:'User denied tool execution'}];p.is_error=true;}
          raw.messages.push({id:'approval-final',role:'assistant',content:[{type:'text',text:`APPROVAL:${answer}`}]});
        }
        result.requests=responseWrites.map(w=>({requestId:w.requestId,state:'written',steps:[{index:w.stepIndex,state:'written'}]}));
      }
      const bytes=Buffer.from(JSON.stringify(raw));result.history={dataBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
      delete result.management; // legacy recorded question retains its observed interaction identity
    }
    if(request.action==='status' && fault==='streaming') {
      const end=streamPhase<=0?97:streamPhase===1?98:streaming.observations.at(-1).seq;
      const rows=streaming.observations.filter(o=>o.seq<=end);
      result.cursor=end;result.observations=rows.filter(o=>o.kind==='pty'&&o.seq>request.cursor);
      const last=rows.filter(o=>o.kind==='history').at(-1);
      if(last){
        const raw=JSON.parse(Buffer.from(last.dataBase64,'base64'));
        const user=raw.messages.find(m=>m.role==='user'&&m.content.some(p=>p.type==='text'));
        if(user)user.content.find(p=>p.type==='text').text=prompt;
        const bytes=Buffer.from(JSON.stringify(raw));result.history={dataBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
      }else delete result.history;
      result.sessionId=streaming.observations.find(o=>o.kind==='binding'&&o.sessionId)?.sessionId;
      delete result.management;
    }
    if(request.action==='status' && fault==='provider-setup'){
      result.sessionId=null;delete result.history;result.process.manifestStatus=null;
      result.observations=onboarding.observations.filter(o=>o.kind==='pty'&&o.seq>request.cursor);
      result.cursor=onboarding.observations.at(-1).seq;
    }
    if(!request.action)result.nativeSessionDirectory='/fixture/default/sessions';
    const finish=()=>{process.stdout.end(JSON.stringify(result));queueMicrotask(() => process.emit('close',0));};
    if(fault==='refresh-race' && request.action==='status' && request.cursor>0)setTimeout(finish,1200);else finish();
  });
  return process;
};
await import('../../examples/chat/server.mjs');
