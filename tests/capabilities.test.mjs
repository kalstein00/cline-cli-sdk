import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';
import {remote,pinned} from './support/remote.mjs';

test('CLI version and binary allowlists do not block an executable with the required options',async t=>{
  remote(t,[{...pinned,cliVersion:'company-build',cliHash:'a'.repeat(64),cliFlags:['--cwd','--data-dir','--auto-approve','--tui','--id','--json']}]);
  const client=createClient({mode:'live',connection:{host:'fixture'}});
  const report=await client.connect();
  assert.equal(report.ready,true);
  assert.equal(report.cliVersion,null);
  assert.equal(report.profile.name,'cline-readline');
  assert.equal(report.profile.companyCompatibility,'unverified');
  assert.equal(report.features.jsonOutput.evidence,'help');
  client.close();
});

test('company declared JSON/zen flags do not grant a verified interaction profile',async t=>{
  remote(t,[{...pinned,cliVersion:'company-unknown',cliHash:'unverified',cliFlags:undefined}]);
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

test('required options and per-mode options still guard launch without a version check',async t=>{
  remote(t,[{...pinned,cliVersion:null,cliFlags:['--cwd','--data-dir','--auto-approve']}]);
  const client=createClient({mode:'live',connection:{host:'fixture'}});
  assert.equal((await client.connect()).ready,true);
  assert.equal(client.capabilities().outputModes.json,false);
  await assert.rejects(client.start({cwd:'/work',prompt:'hello',terminalMode:'tui'}),{code:'cli-option-unavailable'});
  await assert.rejects(client.start({cwd:'/work',prompt:'hello',outputMode:'json'}),{code:'cli-option-unavailable'});
  await assert.rejects(client.start({cwd:'/work',prompt:'hello',retryLimit:2}),{code:'cli-option-unavailable'});
  client.close();
});

test('missing mandatory CLI options blocks start even for a previously observed binary',async t=>{
  remote(t,[{...pinned,cliFlags:['--cwd','--data-dir']}]);
  const client=createClient({mode:'live',connection:{host:'fixture'}});
  const report=await client.connect();
  assert.equal(report.ready,false);assert.ok(report.problems.includes('cli-required-options-missing'));
  await assert.rejects(client.start({cwd:'/work',prompt:'hello'}),{code:'unsupported-profile'});client.close();
});

test('resume requires both session selection and the TUI protocol before reserving a launch',async t=>{
  remote(t,[{...pinned,cliFlags:['--cwd','--data-dir','--auto-approve','--id']}]);
  const client=createClient({mode:'live',connection:{host:'fixture'}});await client.connect();
  await assert.rejects(client.resume({executionId:'run-unselected',requestId:'resume-1',prompt:'hello'}),{code:'cli-option-unavailable'});
  assert.equal(client.capabilities().resume,false);client.close();
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
