import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

async function connectedPage(t,port,fault='') {
  const server = spawn(process.execPath, ['tests/support/chat-browser.mjs'], {
    env:{...process.env,CLINE_CHAT_PORT:String(port),CLINE_CHAT_FAULT:fault},stdio:['ignore','pipe','pipe'],
  });
  t.after(() => server.kill());
  await new Promise((resolve,reject) => {
    let output='';
    server.stdout.on('data',chunk => {output+=chunk; if(output.includes(`http://127.0.0.1:${port}`))resolve();});
    server.stderr.on('data',chunk => output+=chunk);
    server.once('exit',code => reject(new Error(`Consumer server exited ${code}: ${output}`)));
  });
  const browser=await chromium.launch({channel:'chrome',headless:process.env.CLINE_CHAT_HEADLESS === '1'});
  t.after(() => browser.close());
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByLabel('SSH 별칭').fill('fixture');
  await page.getByLabel('CLI 경로').fill('/fixture/cline');
  await page.getByLabel('작업 디렉터리').fill('/fixture/work');
  await page.getByRole('button',{name:'연결 확인',exact:true}).click();
  await page.getByText('연결 준비 완료',{exact:true}).waitFor();
  return page;
}
test('independent consumer displays the first conversation without duplicated messages and preserves its draft', {timeout:30000}, async t => {
  const page=await connectedPage(t,4194);
  await page.getByLabel('메시지', {exact:true}).fill('Reply exactly CHAT_BROWSER_READY.');
  await page.getByRole('button',{name:'첫 메시지 보내기',exact:true}).dblclick();
  await page.getByText('CHAT_BROWSER_READY',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-message-id="user-first"]').count(),1);
  await page.getByLabel('메시지',{exact:true}).fill('전송하지 않은 초안');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('running'));
  assert.equal(await page.getByLabel('메시지',{exact:true}).inputValue(),'전송하지 않은 초안');
  assert.equal(await page.locator('[data-message-id="assistant-first"]').count(),1);
});

test('consumer preserves an uncertain first request when its HTTP response is unavailable', {timeout:30000}, async t => {
  const page=await connectedPage(t,4196);
  await page.route('**/api/start',route=>route.abort());
  await page.locator('#message').fill('Response unknown');await page.getByRole('button',{name:'첫 메시지 보내기',exact:true}).click();
  await page.getByText('전달 여부를 확인해야 합니다. 자동 재전송하지 않습니다.',{exact:false}).waitFor({timeout:5000});
  assert.equal(await page.locator('#send').isDisabled(),true);assert.equal(await page.locator('#connect').isDisabled(),true);
  assert.equal(await page.locator('#message').inputValue(),'Response unknown');
});
test('consumer accepts a Korean first request within the SDK character limit', {timeout:30000}, async t => {
  const page=await connectedPage(t,4197);
  const prompt='한'.repeat(50000);
  await page.locator('#message').fill(prompt);await page.getByRole('button',{name:'첫 메시지 보내기',exact:true}).click();
  await page.getByText('CHAT_BROWSER_READY',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-message-id="user-first"] .text').textContent(),prompt);
});
test('consumer does not call a mismatched launch identity an unsubmitted request', {timeout:30000}, async t => {
  const page=await connectedPage(t,4198,'launch-identity');
  await page.locator('#message').fill('Unknown launch');await page.getByRole('button',{name:'첫 메시지 보내기',exact:true}).click();
  await page.getByText('전달 여부를 확인해야 합니다. 자동 재전송하지 않습니다.',{exact:false}).waitFor({timeout:5000});
  assert.equal(await page.locator('#connect').isDisabled(),true);
  await page.reload();
  await page.getByText('시작 여부를 확인해야 합니다.',{exact:false}).waitFor({timeout:5000});
  assert.equal(await page.locator('#connect').isDisabled(),true);assert.equal(await page.locator('#send').isDisabled(),true);
});

for(const [fault,hint] of [['ready','다음 메시지 입력 준비 완료'],['busy','Cline이 답변을 생성하거나 도구를 실행 중입니다.']]) {
 test(`browser shows public ${fault} input status and enables only witnessed idle send`,{timeout:30000},async t=>{
  const page=await connectedPage(t,fault==='ready'?4200:4201,fault);
  await page.locator('#message').fill('Reply exactly CHAT_BROWSER_READY.');await page.locator('#send').click();
  await page.locator('#hint').filter({hasText:hint}).waitFor();assert.equal(await page.locator('#send').isDisabled(),fault!=='ready');
 });
}

test('consumer keeps an identical followup pending when HTTP is lost and preserves invalid followup drafts',{timeout:30000},async t=>{
 const page=await connectedPage(t,4203,'ready');const text='Reply exactly CHAT_BROWSER_READY.';
 await page.locator('#message').fill(text);await page.locator('#send').click();await page.getByText('CHAT_BROWSER_READY',{exact:true}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('#send').disabled);
 const invalid='한'.repeat(38);await page.locator('#message').fill(invalid);await page.locator('#send').click();
 await page.locator('#error').filter({hasText:'UTF-8 112바이트'}).waitFor();assert.equal(await page.locator('#message').inputValue(),invalid);
 await page.route('**/api/message',route=>route.abort());await page.locator('#message').fill(text);await page.locator('#send').click();
 await page.getByText('전달 여부를 확인해야 합니다. 자동 재전송하지 않습니다.',{exact:false}).waitFor();
 await page.waitForTimeout(1100);assert.equal(await page.locator('#pending').isVisible(),true);assert.equal(await page.locator('#send').isDisabled(),true);
 assert.equal(await page.locator('[data-message-id="user-first"]').count(),1);assert.equal(await page.locator('#message').inputValue(),text);
});

test('consumer displays a current choice question once and uses the composer only for its supported free response',{timeout:30000},async t=>{
 const page=await connectedPage(t,4204,'question');await page.locator('#message').fill('Ask a question');await page.locator('#send').click();
 await page.locator('[data-interaction-id]').waitFor();assert.equal(await page.locator('[data-interaction-id]').count(),1);
 await page.getByRole('button',{name:'BLUE',exact:true}).waitFor();await page.getByRole('button',{name:'질문 응답 보내기',exact:true}).waitFor();
 await page.waitForTimeout(1100);assert.equal(await page.locator('[data-interaction-id]').count(),1);
 await page.route('**/api/respond',route=>route.abort());await page.locator('#message').fill('2 한글 응답 😀');await page.locator('#send').click();
 await page.getByText('전달 여부를 확인해야 합니다. 자동 재전송하지 않습니다.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'BLUE',exact:true}).isDisabled(),true);
});

test('consumer shows full approval arguments and requires an explicit decision while general send is blocked',{timeout:30000},async t=>{
 const page=await connectedPage(t,4207,'approval');await page.locator('#message').fill('Run controlled command');await page.locator('#send').click();
 const approve=page.getByRole('button',{name:'승인',exact:true}),deny=page.getByRole('button',{name:'거절',exact:true});await approve.waitFor();await deny.waitFor();
 await page.waitForFunction(()=>!document.querySelector('#interactions button').disabled);
 assert.equal(await page.locator('#send').isDisabled(),true);const args=await page.locator('.arguments').textContent();assert.ok(args.includes('run_commands'));assert.ok(args.includes('time.sleep(8); print(123)'));
 await page.route('**/api/respond',route=>route.abort());await deny.click();await page.getByText('전달 여부를 확인해야 합니다. 자동 재전송하지 않습니다.',{exact:false}).waitFor();assert.equal(await approve.isDisabled(),true);assert.equal(await deny.isDisabled(),true);
});
