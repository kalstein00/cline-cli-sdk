import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';
import {remote,pinned} from './support/remote.mjs';
import {spawnSync} from 'node:child_process';

test('a proven working directory error preserves connection and permits a corrected start',async t=>{
  remote(t,[pinned,{error:'working-directory-not-found',message:'원격 작업 디렉터리가 없습니다.'},request=>({executionId:request.executionId,remoteRoot:'/fixture/control'})]);
  const client=createClient({mode:'live',connection:{host:'fixture'}});
  t.after(()=>client.close());
  await client.connect();
  await assert.rejects(client.start({cwd:'/missing',prompt:'hello'}),{code:'working-directory-not-found',notSubmitted:true});
  assert.equal(client.snapshot().connection,'connected');
  assert.equal(client.snapshot().executionId,null);
  assert.ok((await client.start({cwd:'/work',prompt:'hello'})).executionId);
});

const host=process.env.CLINE_SDK_TEST_SSH_HOST;
function python(source) {
  const result=spawnSync('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))"`],{encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}
test('real SSH distinguishes missing, file and inaccessible working directories before launching',{skip:!host,timeout:30000},async t=>{
  const dir=python("import tempfile;print(tempfile.mkdtemp(prefix='cline-sdk-cwd-'))");
  assert.match(dir,/^\/tmp\/cline-sdk-cwd-[\w-]+$/);
  python(`import pathlib;p=pathlib.Path(${JSON.stringify(dir)});(p/'file').write_text('x');(p/'blocked').mkdir();(p/'blocked').chmod(0);cli=p/'cline';cli.write_text('#!/usr/bin/env python3\\nprint(\"--cwd --data-dir --auto-approve\")\\n');cli.chmod(0o700)`);
  t.after(()=>python(`import pathlib,shutil;p=pathlib.Path(${JSON.stringify(dir)});(p/'blocked').chmod(0o700);shutil.rmtree(p)`));
  const client=createClient({mode:'live',connection:{host,cliPath:dir+'/cline',remoteRoot:dir+'/control'}});
  t.after(()=>client.close());await client.connect();
  for(const [path,code] of [[dir+'/missing','working-directory-not-found'],[dir+'/file','working-directory-not-directory'],[dir+'/blocked','working-directory-access-denied']]){
    await assert.rejects(client.start({cwd:path,prompt:'do not start'}),{code,notSubmitted:true});
    assert.equal(client.snapshot().connection,'connected');
    assert.equal(client.snapshot().executionId,null);
  }
});
