import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

async function connectedPage(t,port) {
  const server = spawn(process.execPath, ['tests/support/chat-browser.mjs'], {
    env:{...process.env,CLINE_CHAT_PORT:String(port)},stdio:['ignore','pipe','pipe'],
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
