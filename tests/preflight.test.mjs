import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';
import {remote,pinned} from './support/remote.mjs';
import {spawnSync} from 'node:child_process';

test('preflight identifies only the option absent from successfully observed help',async t=>{
  remote(t,[{...pinned,cliFlags:['--cwd','--auto-approve']}]);
  const client=createClient({mode:'live',connection:{host:'fixture'}});
  t.after(()=>client.close());
  const report=await client.connect();
  assert.deepEqual(report.missingOptions,['--data-dir']);
  assert.equal(report.help.state,'success');
  assert.equal(report.ready,false);
  assert.equal(report.profile.companyCompatibility,'unverified');
});

const host=process.env.CLINE_SDK_TEST_SSH_HOST;
function python(source) {
  const result=spawnSync('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))"`],{encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}
test('real SSH observes colored stderr help and distinguishes failed or timed out observation from missing options',{skip:!host,timeout:60000},async t=>{
  const directory=python("import tempfile;print(tempfile.mkdtemp(prefix='cline-sdk-preflight-'))");
  assert.match(directory,/^\/tmp\/cline-sdk-preflight-[\w-]+$/);
  t.after(()=>python(`import shutil;shutil.rmtree(${JSON.stringify(directory)})`));
  for(const [name,script,expected] of [
    ['stderr',"import sys;sys.stderr.write('\\x1b[32m--cwd\\x1b[0m --auto-approve');sys.exit(0)",'success'],
    ['failed',"import sys;sys.stderr.write('missing runtime');sys.exit(2)",'exit-failed'],
    ['unparseable',"print('not option help')",'unparseable'],
    ['truncated',"print('x'*70000)",'truncated'],
    ['timeout',"import time;time.sleep(20)",'timeout'],
  ]){
    const cli=directory+'/'+name;
    python(`import pathlib,base64;p=pathlib.Path(${JSON.stringify(cli)});p.write_bytes(base64.b64decode('${Buffer.from('#!/usr/bin/env python3\n'+script+'\n').toString('base64')}'));p.chmod(0o700)`);
    const client=createClient({mode:'live',connection:{host,cliPath:cli}});
    t.after(()=>client.close());
    const report=await client.connect();
    assert.equal(report.help.state,expected,name);
    assert.equal(report.ready,false);
    assert.deepEqual(report.missingOptions,expected==='success'?['--data-dir']:null);
  }
});

test('failed help does not claim any option is missing',async t=>{
  remote(t,[{...pinned,cliFlags:null,help:{state:'exit-failed',exitCode:2,channels:['stderr']}}]);
  const client=createClient({mode:'live',connection:{host:'fixture'}});
  t.after(()=>client.close());
  const report=await client.connect();
  assert.equal(report.missingOptions,null);
  assert.ok(report.problems.includes('cli-help-exit-failed'));
  assert.ok(!report.problems.includes('cli-required-options-missing'));
  assert.equal(report.ready,false);
});

test('native storage does not require a data-dir option and uses an observed session directory',async t=>{
  remote(t,[{...pinned,cliFlags:['--cwd','--auto-approve','--tui','--id'],nativeSessionDirectory:'/fixture/default/sessions'}]);
  const client=createClient({mode:'live',connection:{host:'fixture',storageMode:'native'}});
  t.after(()=>client.close());
  const report=await client.connect();
  assert.equal(report.ready,true);
  assert.deepEqual(report.missingOptions,[]);
  assert.equal(report.storageMode,'native');
  assert.equal(report.sessionDirectory,'/fixture/default/sessions');
});
