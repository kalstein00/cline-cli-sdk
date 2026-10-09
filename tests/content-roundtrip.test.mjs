import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createClient,readDiagnostic,compareDiagnostic,reviewDiagnostic,exportDiagnostic} from '@cline-cli-sdk/sdk';
import {history} from './support/content-recording.mjs';
import {remote,pinned} from './support/remote.mjs';

test('think/schema/JSON collection exports and replays, and masks span split JSON packets',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cline-sdk-content-roundtrip-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const text='{"secret":"MASK_THIS"}';
  const data=history(1,[{id:'answer',role:'assistant',content:[{type:'thinking',thinking:'VISIBLE MASK_THIS'},{type:'text',text}]}]);
  const output=Buffer.from(JSON.stringify({type:'run_result',finishReason:'completed',text})+'\n');
  const cut=output.indexOf('MASK_THIS')+4;
  const packet=(seq,bytes)=>({kind:'json-output',seq,observedAt:'2026-10-09T10:00:00Z',channel:'stdout',dataBase64:bytes.toString('base64')});
  remote(t,[pinned,r=>({executionId:r.executionId,remoteRoot:'/control',outputMode:'json'}),r=>({executionId:r.executionId,sessionId:'content-session',cursor:2,
    observations:[packet(1,output.subarray(0,cut)),packet(2,output.subarray(cut))],history:{dataBase64:data.dataBase64,sha256:'history'},
    process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot'},alive:false,identityConfirmed:true,exitCode:0,manifestStatus:'completed',children:[],childrenVerified:true,supervisorAlive:false}})]);
  const live=createClient({mode:'live',connection:{host:'fixture'}});t.after(()=>live.close());
  await live.startDiagnostics({directory});await live.connect();
  await live.start({cwd:'/work',prompt:'hello',outputMode:'json',resultFormat:{type:'json',requestId:'roundtrip',schema:{type:'object',properties:{secret:{enum:['MASK_THIS']}},required:['secret'],additionalProperties:false}}});
  await live.refresh();assert.equal(live.snapshot().result.state,'ready');
  const status=await live.stopDiagnostics();
  const review=await reviewDiagnostic(status.path);
  const copy=await exportDiagnostic(status.path,{destination:join(directory,'plain'),reviewToken:review.reviewToken});
  const bundle=await readDiagnostic(copy.path);const replay=createClient({mode:'replay'});const events=[];replay.subscribe(e=>events.push(e));
  await replay.openReplay(bundle.recording);await replay.replayAll();
  assert.equal(compareDiagnostic(bundle,events,replay.snapshot()).matches,true);
  const legacy=structuredClone(bundle);legacy.metadata.adapterVersion=1;
  assert.equal(compareDiagnostic(legacy,events,replay.snapshot()).available,false);
  assert.deepEqual(replay.snapshot().result.value,{secret:'MASK_THIS'});replay.close();
  const masked=await exportDiagnostic(status.path,{destination:join(directory,'masked'),reviewToken:review.reviewToken,masks:['MASK_THIS']});
  const changed=await readDiagnostic(masked.path);
  const stdout=changed.recording.observations.filter(o=>o.kind==='json-output'&&o.channel==='stdout').map(o=>Buffer.from(o.dataBase64,'base64').toString()).join('');
  assert.equal(stdout.includes('MASK_THIS'),false);
  assert.equal(changed.metadata.export.replayImpact.comparison,'unavailable');
});
