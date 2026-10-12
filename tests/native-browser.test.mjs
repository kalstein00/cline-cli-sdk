import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createClient} from '@cline-cli-sdk/sdk';

// Explicit opt-in: this uses the installed CLI and its existing provider/settings.
// CLI-created test conversations remain in its history; only SDK-owned runs stop.
const host=process.env.CLINE_SDK_TEST_SSH_HOST,cliPath=process.env.CLINE_SDK_TEST_NATIVE_CLI;
function python(source){const r=spawnSync('ssh',[host,`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))"`],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
test('installed native CLI works in the browser across questions, approvals, app restart, stop and resume',{skip:!host||!cliPath,timeout:300000},async()=>{
 const root=python("import tempfile;print(tempfile.mkdtemp(prefix='cline-sdk-native-browser-'))");assert.match(root,/^\/tmp\/cline-sdk-native-browser-[\w-]+$/);
 const port=4248,url=`http://127.0.0.1:${port}`,remoteRoot=root+'/control',evidence={root,steps:[]};let server,browser;
 const launch=async()=>{
  server=spawn(process.execPath,['examples/chat/server.mjs'],{env:{...process.env,CLINE_CHAT_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let output='';server.stdout.on('data',chunk=>{output+=chunk;if(output.includes(url))resolve();});server.stderr.on('data',c=>output+=c);server.once('exit',code=>reject(Error(`Server exited ${code}: ${output}`)));});
 };
 const halt=async()=>{if(server&&!server.killed){const ended=new Promise(resolve=>server.once('exit',resolve));server.kill();await ended;}};
 try{
  await launch();browser=await chromium.launch({channel:'chrome',headless:process.env.CLINE_CHAT_HEADLESS==='1'});const page=await browser.newPage();page.setDefaultTimeout(60000);
  const state=()=>page.request.get(url+'/api/state').then(r=>r.json());
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#send').disabled&&!document.querySelector('#pending').offsetHeight);
  const send=async text=>{await ready();await page.locator('#message').fill(text);await page.locator('#send').click();};
  await page.goto(url);await page.locator('#host').fill(host);await page.locator('#cliPath').fill(cliPath);await page.locator('#remoteRoot').fill(remoteRoot);await page.locator('#cwd').fill(root);
  await page.locator('#connect').click();await page.getByText('연결 준비 완료',{exact:true}).waitFor();assert.equal(await page.locator('#dataDir').isDisabled(),true);
  await send('Use ask_question: Pick a color, RED/BLUE choices. Reply COLOR: plus my exact answer. No other tools.');
  await page.getByRole('button',{name:'BLUE',exact:true}).waitFor();const pending=(await state()).snapshot;
  await page.locator('#disconnect').click();await page.locator('#connection').filter({hasText:'disconnected'}).waitFor();assert.equal(await page.getByRole('button',{name:'BLUE',exact:true}).isDisabled(),true);
  await page.reload();await page.locator('#reconnect').click();await page.locator('#connection').filter({hasText:'connected'}).waitFor();
  assert.equal((await state()).snapshot.sessionId,pending.sessionId);assert.deepEqual((await state()).snapshot.executionEvidence.identity,pending.executionEvidence.identity);
  await page.getByRole('button',{name:'BLUE',exact:true}).click();await page.locator('#messages [data-role=assistant] .text').filter({hasText:'COLOR:BLUE'}).waitFor();await ready();
  evidence.steps.push({name:'question-reconnect',snapshot:(await state()).snapshot});
  await send('Use ask_question: Enter an identifier, RED/BLUE choices. Reply IDENTIFIER: plus my exact answer.');
  await page.getByRole('button',{name:'질문 응답 보내기',exact:true}).waitFor();await page.locator('#message').fill('2 한글 identifier');await page.locator('#send').click();
  await page.locator('#messages [data-role=assistant] .text').filter({hasText:'IDENTIFIER:2 한글 identifier'}).waitFor();await ready();
  for(const [answer,file] of [['승인','approved-marker'],['거절','denied-marker']]){
   await send(`run_commands: printf SDK_APPROVAL > ${file}. Reply SDK_APPROVAL_DONE. No other tools.`);
   const button=page.getByRole('button',{name:answer,exact:true});await button.waitFor();const approval=(await state()).snapshot.interaction;
   assert.deepEqual(approval.toolInput.commands,[`printf SDK_APPROVAL > ${file}`]);await button.click();await ready();
   assert.equal(python(`import pathlib;print(pathlib.Path(${JSON.stringify(root+'/'+file)}).exists())`),answer==='승인'?'True':'False');
   evidence.steps.push({name:answer,snapshot:(await state()).snapshot});
  }
  const before=(await state()).snapshot;await page.locator('#message').fill('browser draft');await halt();await launch();await page.reload();await page.locator('#connect').click();await ready();
  const restored=(await state()).snapshot;assert.equal(restored.sessionId,before.sessionId);assert.equal(restored.executionId,before.executionId);assert.deepEqual(restored.executionEvidence.identity,before.executionEvidence.identity);assert.equal(await page.locator('#message').inputValue(),'browser draft');
  await page.locator('#stop').click();await page.locator('#stopStatus').filter({hasText:'중단 확인'}).waitFor();await ready();const stopped=(await state()).snapshot;assert.equal(stopped.stop.state,'confirmed');assert.equal(stopped.stop.childrenVerified,true);assert.deepEqual(stopped.stop.remaining,[]);
  await send('Reply exactly SDK_BROWSER_RESUMED. No tools.');await page.locator('#messages [data-role=assistant] .text').filter({hasText:'SDK_BROWSER_RESUMED'}).waitFor();await ready();
  const resumed=(await state()).snapshot;assert.equal(resumed.sessionId,before.sessionId);assert.notEqual(resumed.executionId,before.executionId);assert.equal(resumed.resume.state,'delivered');
  evidence.steps.push({name:'app-restart-stop-resume',snapshot:resumed});evidence.success=true;
  await mkdir('.scratch/company-cli-30',{recursive:true});await page.screenshot({path:'.scratch/company-cli-30/native-browser.png',fullPage:true});
 }catch(error){evidence.error=error.message;throw error;}
 finally{
  await mkdir('.scratch/company-cli-30',{recursive:true});await writeFile('.scratch/company-cli-30/native-browser-result.json',JSON.stringify(evidence,null,2));
  const cleanup=createClient({mode:'live',connection:{host,cliPath,storageMode:'native',remoteRoot}});
  try{await cleanup.connect();for(const run of await cleanup.listManagedExecutions()){if(run.supersededBy)continue;await cleanup.attach(run.executionId);if(cleanup.snapshot().executionEvidence?.alive)await cleanup.stop({executionId:run.executionId,requestId:randomUUID()});}}finally{cleanup.close();await browser?.close();await halt();}
 }
});
