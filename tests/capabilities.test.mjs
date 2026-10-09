import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';
import {remote,pinned} from './support/remote.mjs';

test('company declared JSON/zen flags do not grant a verified interaction profile',async t=>{
  remote(t,[{...pinned,cliVersion:'company-unknown',cliHash:'unverified'}]);
  const client=createClient({mode:'live',connection:{host:'fixture',declaredFeatures:{zen:false,jsonOutput:true}}});
  const report=await client.connect();
  assert.deepEqual(report.features.jsonOutput,{availability:'supported',evidence:'declared',reason:'User declaration; execution profile remains unverified.'});
  assert.equal(report.features.zen.availability,'unsupported');
  assert.equal(report.features.jsonInteraction.availability,'unknown');
  assert.equal(report.features.nativeSchema.availability,'unknown');
  assert.equal(report.ready,false);
  assert.equal(client.capabilities().outputModes.json,false);
  await assert.rejects(client.start({cwd:'/work',prompt:'hello',outputMode:'json'}),{code:'unsupported-profile'});
  client.close();
});

test('help observations and company declarations stay distinct and cannot enable resume',async t=>{
  remote(t,[{...pinned,cliHash:'company',cliVersion:'company',cliFlags:['--json']}]);
  const client=createClient({mode:'live',connection:{host:'fixture',declaredFeatures:{zen:false,jsonOutput:true}}});
  const report=await client.connect();
  assert.equal(report.features.jsonOutput.evidence,'help');
  assert.equal(report.features.zen.availability,'unsupported');
  assert.equal(report.features.zen.evidence,'declared');
  assert.equal(client.capabilities().resume,false);
  client.close();
});
