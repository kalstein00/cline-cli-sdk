import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

async function connectedPage(t,port,fault='') {
 const server=spawn(process.execPath,['tests/support/chat-browser.mjs'],{env:{...process.env,CLINE_CHAT_PORT:String(port),CLINE_CHAT_FAULT:fault},windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(()=>server.kill());
 await new Promise((resolve,reject)=>{server.stdout.on('data',chunk=>{if(chunk.toString().includes('http://127.0.0.1:'))resolve();});server.once('exit',code=>reject(Error('Server exited '+code)));});
 const browser=await chromium.launch({channel:'chrome',headless:process.env.CLINE_CHAT_HEADLESS==='1'});t.after(()=>browser.close());
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+port);
 await page.getByLabel('SSH 별칭').fill('fixture');await page.getByLabel('작업 디렉터리').fill('/work');
 await page.getByRole('button',{name:'연결 확인',exact:true}).click();await page.getByText('연결 준비 완료',{exact:true}).waitFor();
 return page;
}
test('browser starts a direct CLI pane and disables followup, approval and stop controls',{timeout:30000},async t=>{
 const page=await connectedPage(t,4226);await page.locator('#message').fill('First request');await page.locator('#send').click();
 await page.locator('#terminalText').filter({hasText:'Company custom CLI'}).waitFor();
 assert.equal(await page.locator('#send').isDisabled(),true);assert.equal(await page.locator('#stop').isDisabled(),true);
 assert.match(await page.locator('#hint').innerText(),/읽기 전용/);
 const state=await page.request.get('http://127.0.0.1:4226/api/state').then(r=>r.json());
 for(const method of ['stop','sendMessage','responses','resume'])assert.equal(state.capabilities[method],false);
 const response=await page.request.post('http://127.0.0.1:4226/api/message',{data:{serverId:state.serverId,generation:state.generation,requestId:'blocked-message',text:'must not send'}});
 assert.equal((await response.json()).error,'remote-input-disabled');
});
test('browser selects existing JSON history without launching or enabling input',{timeout:30000},async t=>{
 const page=await connectedPage(t,4227);await page.locator('[data-execution-id="history:saved-chat"]').click();
 await page.locator('#messages').filter({hasText:'Prior conversation'}).waitFor();
 assert.equal(await page.locator('#send').isDisabled(),true);assert.equal(await page.locator('#stop').isDisabled(),true);
 assert.match(await page.locator('#status').innerText(),/읽기 전용/);
});
test('browser keeps an uncertain launch visible and prevents a second automatic start',{timeout:30000},async t=>{
 const page=await connectedPage(t,4228,'launch-unknown');await page.locator('#message').fill('First request');await page.locator('#send').click();
 await page.locator('#status').filter({hasText:'실행 생성 여부 불명'}).waitFor();
 assert.equal(await page.locator('#send').isDisabled(),true);assert.equal(await page.locator('#new').isDisabled(),true);
});
