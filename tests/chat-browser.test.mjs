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
  await page.addInitScript(()=>{const Native=window.EventSource;window.EventSource=class extends Native{constructor(...args){super(...args);window.testEvents=this;}};});
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
  assert.equal(await page.locator('#new').isDisabled(),true);
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

test('managed conversation selection keeps drafts and filters stale prior snapshots and input',{timeout:45000},async t=>{
 const page=await connectedPage(t,4209,'multi');await page.locator('#message').fill('Conversation A');await page.locator('#send').click();await page.getByText('CHAT_BROWSER_READY',{exact:true}).waitFor();
 const first=await page.request.get('http://127.0.0.1:4209/api/state').then(r=>r.json());await page.locator('#message').fill('A draft');
 await page.getByRole('button',{name:'＋ 새 대화',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('#send').textContent==='첫 메시지 보내기');
 await page.locator('#message').fill('Conversation B');await page.locator('#send').click();await page.getByText('CHAT_BROWSER_READY',{exact:true}).waitFor();
 await page.locator('#message').fill('B draft');const second=await page.request.get('http://127.0.0.1:4209/api/state').then(r=>r.json());
 await page.locator('#conversations button').filter({hasText:'Conversation A'}).click();await page.locator('article[data-role=user] .text').filter({hasText:'Conversation A'}).waitFor();assert.equal(await page.locator('#message').inputValue(),'A draft');
 assert.equal(await page.locator('article[data-role=user] .text').filter({hasText:'Conversation B'}).count(),0);
 await page.evaluate(packet=>window.testEvents.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({...packet,error:'late-error'})})),second);
 assert.equal(await page.locator('article[data-role=user] .text').filter({hasText:'Conversation B'}).count(),0);assert.equal(await page.locator('#message').inputValue(),'A draft');
 const stale=await page.request.post('http://127.0.0.1:4209/api/message',{data:{generation:second.generation,requestId:'stale-other',sessionId:second.snapshot.sessionId,executionId:second.snapshot.executionId,revision:second.snapshot.revision,text:'stale input'}}).then(r=>r.json());assert.equal(stale.error,'selection-changed');
 await page.locator('#conversations button').filter({hasText:'Conversation B'}).click();await page.locator('article[data-role=user] .text').filter({hasText:'Conversation B'}).waitFor();assert.equal(await page.locator('#message').inputValue(),'B draft');
 assert.notEqual(first.snapshot.executionId,second.snapshot.executionId);
});

test('incomplete attach blocks first input and an old transport error cannot leak into a newer selection',{timeout:30000},async t=>{
 const page=await connectedPage(t,4211,'ready');await page.locator('#message').fill('Initial');await page.locator('#send').click();await page.getByText('CHAT_BROWSER_READY',{exact:true}).waitFor();
 const packet=await page.request.get('http://127.0.0.1:4211/api/state').then(r=>r.json());
 let release;const gate=new Promise(r=>release=r);let intercepted;const arrived=new Promise(r=>intercepted=r);
 await page.route('**/api/list',async route=>{intercepted();await gate;await route.abort();});await page.locator('#list').click();await arrived;
 await page.evaluate(p=>window.testEvents.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({...p,generation:p.generation+2,busy:false,selectedId:'run-incomplete',snapshot:{...p.snapshot,executionId:null,sessionId:null,messages:[]}})})),packet);
 release();await page.waitForTimeout(250);assert.equal(await page.locator('#error').isVisible(),false);assert.equal(await page.locator('#send').isDisabled(),true);
});

test('disconnect and browser reload restore the same pending question and keep all input blocked while detached',{timeout:30000},async t=>{
 const page=await connectedPage(t,4212,'question');await page.locator('#message').fill('Ask a reconnect question');await page.locator('#send').click();await page.locator('[data-interaction-id]').waitFor();
 const before=await page.request.get('http://127.0.0.1:4212/api/state').then(r=>r.json());await page.locator('#disconnect').click();await page.locator('#connection').filter({hasText:'disconnected'}).waitFor();assert.equal(await page.locator('#send').isDisabled(),true);assert.equal(await page.getByRole('button',{name:'BLUE',exact:true}).isDisabled(),true);
 await page.reload();await page.locator('[data-interaction-id]').waitFor();assert.equal(await page.locator('#connection').textContent(),'disconnected');await page.locator('#reconnect').click();await page.locator('#connection').filter({hasText:'connected'}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('#interactions button').disabled);const after=await page.request.get('http://127.0.0.1:4212/api/state').then(r=>r.json());assert.equal(after.snapshot.executionId,before.snapshot.executionId);assert.equal(after.snapshot.sessionId,before.snapshot.sessionId);assert.equal(after.snapshot.interaction.id,before.snapshot.interaction.id);assert.deepEqual(after.snapshot.messages,before.snapshot.messages);
});

for(const [fault,confirmed] of [['stop-confirmed',true],['stop-unknown',false]])test(`explicit ${fault} preserves history and only confirmed termination enables resume`,{timeout:30000},async t=>{
 const page=await connectedPage(t,confirmed?4215:4216,fault);await page.locator('#message').fill('Controlled stop');await page.locator('#send').click();await page.getByText('CHAT_BROWSER_READY',{exact:true}).waitFor();const before=await page.request.get(`http://127.0.0.1:${confirmed?4215:4216}/api/state`).then(r=>r.json());
 await page.getByRole('button',{name:'작업 중단',exact:true}).click();await page.locator('#stopStatus').filter({hasText:confirmed?'중단 확인':'중단 여부 불명'}).waitFor();assert.equal(await page.locator('#send').isDisabled(),!confirmed);assert.equal(await page.locator('[data-message-id="user-first"] .text').textContent(),'Controlled stop');
 if(confirmed){assert.equal(await page.locator('#send').textContent(),'대화 재개하여 보내기');await page.locator('#message').fill('한'.repeat(38));await page.locator('#send').click();await page.locator('#error').filter({hasText:'UTF-8 112바이트'}).waitFor();}
 const after=await page.request.get(`http://127.0.0.1:${confirmed?4215:4216}/api/state`).then(r=>r.json());assert.equal(after.snapshot.executionId,before.snapshot.executionId);assert.deepEqual(after.snapshot.messages,before.snapshot.messages);
});

test('consumer preserves reading position and draft during history recovery and renders message text safely',{timeout:30000},async t=>{
 const page=await connectedPage(t,4220,'ready');await page.locator('#message').fill('Read history');await page.locator('#send').click();await page.getByText('CHAT_BROWSER_READY',{exact:true}).waitFor();
 const packet=await page.request.get('http://127.0.0.1:4220/api/state').then(r=>r.json());
 const history=Array.from({length:40},(_,i)=>({id:`history-${i}`,role:i%2?'assistant':'user',text:`Prior message ${i}\n${'Long paragraph. '.repeat(20)}`}));
 const updated={...packet,snapshot:{...packet.snapshot,revision:packet.snapshot.revision+1000,messages:[...packet.snapshot.messages,...history]}};
 await page.evaluate(p=>window.testEvents.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(p)})),updated);
 await page.locator('#message').fill('Reading draft');const top=await page.locator('#timeline').evaluate(e=>{e.scrollTop=160;return e.scrollTop;});assert.equal(top,160);
 updated.snapshot={...updated.snapshot,revision:updated.snapshot.revision+1,historySync:{...updated.snapshot.historySync,current:false},messages:[...updated.snapshot.messages,{id:'latest-safe',role:'assistant',text:'<img src=x onerror="window.unsafe=true"> New answer'}]};
 await page.evaluate(p=>window.testEvents.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(p)})),updated);
 assert.equal(await page.locator('#timeline').evaluate(e=>e.scrollTop),top);assert.equal(await page.locator('#message').inputValue(),'Reading draft');assert.equal(await page.locator('[data-message-id="user-first"]').count(),1);
 await page.locator('#hint').filter({hasText:'마지막 정상 대화를 유지'}).waitFor();assert.equal(await page.locator('#newMessages').isVisible(),true);assert.equal(await page.locator('#messages img').count(),0);assert.equal(await page.evaluate(()=>window.unsafe),undefined);
 const stored=await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)));assert.deepEqual(Object.keys(stored).sort(),['cline-chat-selected','cline-chat-settings']);assert.equal(JSON.stringify(stored).includes('Reading draft'),false);
});

test('IME Enter does not submit and a multiline followup is rejected before HTTP while preserving its draft',{timeout:30000},async t=>{
 const page=await connectedPage(t,4221,'ready');await page.locator('#message').fill('IME baseline');await page.locator('#send').click();await page.getByText('CHAT_BROWSER_READY',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
 let sends=0;await page.route('**/api/message',route=>{sends++;return route.abort();});await page.locator('#message').fill('한글 조합');await page.locator('#message').dispatchEvent('keydown',{key:'Enter',isComposing:true});await page.waitForTimeout(100);assert.equal(sends,0);assert.equal(await page.locator('#pending').isVisible(),false);
 await page.locator('#message').fill('first\nsecond');await page.locator('#send').click();await page.locator('#error').filter({hasText:'한 줄'}).waitFor();assert.equal(sends,0);assert.equal(await page.locator('#message').inputValue(),'first\nsecond');
});
