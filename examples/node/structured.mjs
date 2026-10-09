import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createClient,readDiagnostic,compareDiagnostic,reviewDiagnostic,exportDiagnostic} from '@cline-cli-sdk/sdk';

const connection={host:process.env.CLINE_SDK_HOST,cliPath:process.env.CLINE_SDK_CLI_PATH,remoteRoot:process.env.CLINE_SDK_REMOTE_ROOT};
const directory=process.env.CLINE_SDK_EVIDENCE_DIR;
if(!connection.host || !directory || !process.env.CLINE_SDK_WORKSPACE || !process.env.CLINE_SDK_DATA_DIR) throw Error('Set host, remote workspace/data/control and local evidence directory explicitly.');
await mkdir(directory,{recursive:true});
const report=[];
const waitFor=async(client,predicate,label)=>{
  const deadline=Date.now()+90000;
  while(Date.now()<deadline) {
    const snapshot=await client.refresh();
    if(predicate(snapshot))return snapshot;
    if(snapshot.execution==='failed')throw Error(label+': CLI failed');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error(label+': timed out; inspect diagnostics');
};
for(const tag of ['first','second']) {
  let client=createClient({mode:'live',connection});
  let executionId;
  const firstEvents=[];const unsubscribe=client.subscribe(e=>firstEvents.push(e));
  try {
    await client.startDiagnostics({directory:join(directory,'launch-'+tag)});
    const preflight=await client.connect();assert.equal(preflight.ready,true);
    const expected={sessionTag:tag,items:[1,2],note:'한글'};
    const schema={type:'object',properties:{sessionTag:{type:'string',enum:[tag]},items:{type:'array',items:{type:'integer'},const:[1,2]},note:{type:'string',const:'한글'}},required:['sessionTag','items','note'],additionalProperties:false};
    await client.start({cwd:process.env.CLINE_SDK_WORKSPACE,dataDir:process.env.CLINE_SDK_DATA_DIR,terminalMode:'tui',prompt:'Return ONLY this exact JSON object: '+JSON.stringify(expected)+'. Do not call tools.',resultFormat:{type:'json',requestId:'request-'+tag,schema}});
    executionId=client.snapshot().executionId;
    const beforeClose=await waitFor(client,s=>s.sessionId && s.executionEvidence?.alive && s.executionEvidence.identityConfirmed,'active '+tag);
    const launchDiagnostics=await client.stopDiagnostics();
    client.close();unsubscribe();const originalEventCount=firstEvents.length;
    client=createClient({mode:'live',connection});
    await client.startDiagnostics({directory:join(directory,'recovery-'+tag)});
    await client.connect();
    const managed=(await client.listManagedExecutions()).find(run=>run.executionId===executionId);
    assert.equal(managed.resultRequest.requestId,'request-'+tag);
    await client.attach(executionId);
    const final=await waitFor(client,s=>s.result?.state==='ready','result '+tag);
    assert.equal(final.executionId,beforeClose.executionId);assert.equal(final.sessionId,beforeClose.sessionId);
    assert.deepEqual(final.result.value,expected);assert.equal(final.result.validation,'sdk-schema');
    assert.equal(firstEvents.length,originalEventCount);
    const stop=await client.stop({executionId,requestId:'stop-'+tag});
    assert.equal(stop.state,'confirmed');assert.equal(stop.childrenVerified,true);
    const diagnostic=await client.stopDiagnostics();
    const review=await reviewDiagnostic(diagnostic.path);
    const exported=await exportDiagnostic(diagnostic.path,{destination:join(directory,'export-'+tag),reviewToken:review.reviewToken});
    const bundle=await readDiagnostic(exported.path);
    const replay=createClient({mode:'replay'});const events=[];replay.subscribe(e=>events.push(e));
    await replay.openReplay(bundle.recording);await replay.replayAll();
    const comparison=compareDiagnostic(bundle,events,replay.snapshot());assert.equal(comparison.matches,true);
    assert.deepEqual(replay.snapshot().result.value,expected);replay.close();
    report.push({tag,sessionId:final.sessionId,executionId,requestId:final.result.requestId,value:final.result.value,beforeCloseAlive:beforeClose.executionEvidence.alive,reconnectedSameExecution:true,stop,launchDiagnostics:launchDiagnostics.path,diagnostics:diagnostic.path,exported:exported.path,diagnosticMatches:comparison.matches,thinkingParts:final.messages.flatMap(m=>m.content??[]).filter(p=>p.type==='thinking').length});
    console.log(JSON.stringify(report.at(-1)));
  } finally {
    if(executionId && client.snapshot().connection==='connected' && client.snapshot().executionId===executionId && !['stopped','completed','failed'].includes(client.snapshot().execution)) {
      const stop=await client.stop({executionId,requestId:'cleanup-'+tag});console.log(JSON.stringify({cleanup:stop.state,childrenVerified:stop.childrenVerified}));
    }
    await client.stopDiagnostics();client.close();unsubscribe();
  }
}
assert.equal(new Set(report.map(r=>r.sessionId)).size,2);
assert.equal(new Set(report.map(r=>r.executionId)).size,2);
const resumed=createClient({mode:'live',connection});
let resumedId;
let resumeReport;
try {
  await resumed.connect();await resumed.attach(report[0].executionId);
  await resumed.resume({executionId:report[0].executionId,requestId:'resume-first',prompt:'Reply ONLY with the exact text RESUME_NEW_RUN. Do not call tools.'});
  resumedId=resumed.snapshot().executionId;
  assert.notEqual(resumedId,report[0].executionId);assert.equal(resumed.snapshot().result,undefined);
  const final=await waitFor(resumed,s=>s.messages.some(m=>m.role==='assistant'&&m.text==='RESUME_NEW_RUN') && s.executionEvidence?.identityConfirmed,'resume');
  assert.equal(final.sessionId,report[0].sessionId);assert.equal(final.result,undefined);
  const stop=await resumed.stop({executionId:resumedId,requestId:'stop-resume'});
  assert.equal(stop.state,'confirmed');assert.equal(stop.childrenVerified,true);
  resumeReport={sessionId:final.sessionId,previousExecutionId:report[0].executionId,executionId:resumedId,oldResultCleared:true,newAnswer:'RESUME_NEW_RUN',stop};
} finally {
  if(resumedId && !['stopped','completed','failed'].includes(resumed.snapshot().execution)) await resumed.stop({executionId:resumedId,requestId:'cleanup-resume'});
  resumed.close();
}
await writeFile(join(directory,'two-sessions.json'),JSON.stringify({passed:true,source:'actual pinned public CLI; packed independent consumer',sessions:report,resume:resumeReport},null,2));
console.log('Two independent sessions, close/reconnect, schema results, stop and diagnostic replay passed.');
