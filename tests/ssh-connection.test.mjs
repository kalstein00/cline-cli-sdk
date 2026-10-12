import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';
import {spawn} from 'node:child_process';
import {mkdtemp,readdir,rm,unlink,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';

const host=process.env.CLINE_SDK_TEST_SSH_HOST;

// The configured OpenSSH/ProxyCommand path is real. Only reads occur; /bin/true
// avoids the installed Cline, model credentials, and existing conversations.
test('consumers can repeat concurrent preflight reads through their configured SSH connection', {skip:!host,timeout:20000},async t=>{
 const clients=Array.from({length:3},()=>createClient({mode:'live',connection:{host,cliPath:'/bin/true',timeoutMs:5000}}));
 t.after(()=>clients.forEach(client=>client.close()));
 for(let i=0;i<4;i++){
  const results=await Promise.allSettled(clients.map(async client=>{
   const report=await client.connect();
   assert.equal(report.platform,'Linux');
   assert.equal(client.snapshot().connection,'connected');
  }));
  for(const result of results)assert.equal(result.status,'fulfilled',result.reason?.message);
 }
});

// Isolate the documented proxy cache through the child process TEMP/TMP. The
// filesystem fault is setup only; success is observed through the public SDK.
async function connectWithTemporaryCache(directory,count=1) {
 const source=`
  import {createClient} from '@cline-cli-sdk/sdk';
  const clients=Array.from({length:${count}},()=>createClient({mode:'live',connection:{host:process.env.CLINE_SDK_TEST_SSH_HOST,cliPath:'/bin/true',timeoutMs:20000}}));
  try {
   const results=await Promise.allSettled(clients.map(async client=>{
    const report=await client.connect();
    if(client.snapshot().connection!=='connected')throw Error('Consumer is not connected');
    return report.platform;
   }));
   const failure=results.find(result=>result.status==='rejected');
   if(failure)throw failure.reason;
   console.log(JSON.stringify(results.map(result=>result.value)));
  }catch(error){console.error(error.message);process.exitCode=1;}
  finally{clients.forEach(client=>client.close());}
 `;
 return await new Promise((accept,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',source],{
   windowsHide:true,env:{...process.env,TEMP:directory,TMP:directory},stdio:['ignore','pipe','pipe']
  });
  let output='',error='';
  child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);
  child.once('error',reject);
  child.once('close',code=>accept({code,output,error}));
 });
}

test('consumers recover concurrent SSH connections after address discovery leaves an abandoned empty lock',{
 skip:process.platform!=='win32'||host!=='wsl',timeout:60000
},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'cline-sdk-proxy-recovery-'));
 assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'cline-sdk-proxy-recovery-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const initial=await connectWithTemporaryCache(directory);
 assert.equal(initial.code,0,initial.error);
 const cacheDirectory=join(directory,'cline-sdk-wsl-ssh');
 const files=(await readdir(cacheDirectory)).filter(name=>name.endsWith('.json'));
 assert.equal(files.length,1,'Configure Host wsl with scripts/wsl-ssh-proxy.mjs for this development transport test');
 const cachePath=join(cacheDirectory,files[0]),lockPath=cachePath+'.lock';
 await unlink(cachePath);
 await writeFile(lockPath,'');
 const abandonedAt=new Date(Date.now()-60000);
 await utimes(lockPath,abandonedAt,abandonedAt);
 const recovered=await connectWithTemporaryCache(directory,3);
 assert.equal(recovered.code,0,recovered.error);
 assert.deepEqual(JSON.parse(recovered.output),['Linux','Linux','Linux']);
});

test('consumers receive a bounded busy failure rather than steal address discovery from a live owner',{
 skip:process.platform!=='win32'||host!=='wsl',timeout:60000
},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'cline-sdk-proxy-owner-'));
 assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'cline-sdk-proxy-owner-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const initial=await connectWithTemporaryCache(directory);
 assert.equal(initial.code,0,initial.error);
 const cacheDirectory=join(directory,'cline-sdk-wsl-ssh');
 const files=(await readdir(cacheDirectory)).filter(name=>name.endsWith('.json'));
 assert.equal(files.length,1);
 const cachePath=join(cacheDirectory,files[0]);
 await unlink(cachePath);
 // This test process owns the fault: it remains alive while the clients wait.
 await writeFile(cachePath+'.lock',JSON.stringify({at:Date.now()-60000,pid:process.pid}));
 const waiting=await connectWithTemporaryCache(directory,3);
 assert.equal(waiting.code,1,'An active discovery owner must not be replaced');
 assert.match(waiting.error,/WSL address discovery is busy; connection was not established/);
});
