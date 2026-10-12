import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createClient} from '@cline-cli-sdk/sdk';
import {readFile} from 'node:fs/promises';
test('observed WSL native question replays with its choices and free response unchanged',async()=>{
 const recording=JSON.parse(await readFile(new URL('../fixtures/native/wsl-question.json',import.meta.url),'utf8'));
 const client=createClient({mode:'replay'});await client.openReplay(recording);await client.replayAll();
 assert.equal(client.snapshot().interaction.kind,'question');assert.equal(client.snapshot().interaction.prompt,'Pick a color:');
 assert.deepEqual(client.snapshot().interaction.choices,['RED','BLUE']);assert.deepEqual(client.snapshot().interaction.responseKinds,['choice','text']);client.close();
});
const host=process.env.CLINE_SDK_TEST_SSH_HOST;
function python(source){const r=spawnSync('ssh',[host,`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))"`],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
async function until(client,accept){for(let i=0;i<25;i++){const s=await client.refresh();if(accept(s))return s;await new Promise(r=>setTimeout(r,100));}throw Error(JSON.stringify(client.snapshot()));}
test('native storage preserves prior conversations and supports input, reattachment, child stop and same-session resume',{skip:!host,timeout:90000},async()=>{
 const directory=python("import tempfile;print(tempfile.mkdtemp(prefix='cline-sdk-native-test-'))");assert.match(directory,/^\/tmp\/cline-sdk-native-test-[\w-]+$/);
 const sessions=directory+'/sessions',cli=directory+'/cline';
 const source=`#!/usr/bin/env python3
import os,sys,pathlib,json,subprocess,tty
base=pathlib.Path(__file__).parent
if '--help' in sys.argv:print('--cwd --auto-approve --tui --id');sys.exit(0)
if '--cline-hub-daemon' in sys.argv:
 import time;time.sleep(120);sys.exit(0)
assert '--data-dir' not in sys.argv
assert pathlib.Path.cwd()==base/'작업 폴더'
hub=subprocess.Popen([sys.executable,__file__,'--cline-hub-daemon'])
pathlib.Path(os.environ['CLINE_HUB_DISCOVERY_PATH']).write_text(json.dumps(dict(pid=hub.pid)))
sid='owned-native';folder=base/'sessions'/sid;folder.mkdir(exist_ok=True)
(base/'sessions'/'concurrent').mkdir(exist_ok=True)
(base/'sessions'/'concurrent'/'concurrent.json').write_text(json.dumps(dict(session_id='concurrent',pid=os.getppid(),status='idle')))
(folder/(sid+'.json')).write_text(json.dumps(dict(session_id=sid,pid=os.getpid(),status='idle')))
messages=json.loads((folder/(sid+'.messages.json')).read_text())['messages'] if '--id' in sys.argv else [dict(id='u0',role='user',content=[dict(type='text',text='native prompt')]),dict(id='a0',role='assistant',content=[dict(type='text',text='NATIVE_READY')])]
def history():
 p=folder/(sid+'.messages.json');tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(dict(version=1,sessionId=sid,messages=messages)));tmp.replace(p)
def screen(text=''):
 rule='─'*120
 sys.stdout.write('\\x1b[2J\\x1b[35;1H'+rule+'\\x1b[36;1H❯ '+(text or 'Ask anything...')+'\\x1b[37;1H'+rule+'\\x1b[38;1H● Act (Tab)\\x1b[40;1HAuto-approve all disabled (Shift+Tab)'+f'\\x1b[36;{3+len(text)}H');sys.stdout.flush()
tty.setraw(sys.stdin.fileno());history();screen();text=''
while True:
 value=os.read(sys.stdin.fileno(),64).decode('utf8')
 if '\\r' in value:
  if text=='spawn':subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'])
  n=len(messages);messages.extend([dict(id='u'+str(n),role='user',content=[dict(type='text',text=text)]),dict(id='a'+str(n),role='assistant',content=[dict(type='text',text='NATIVE_REPLY')],metrics=dict(inputTokens=1,outputTokens=1))]);history();text=''
 else:text+=value
 screen(text)
`;
 python(`import pathlib,base64,json\nb=pathlib.Path(${JSON.stringify(directory)});(b/'작업 폴더').mkdir();(b/'sessions'/'old').mkdir(parents=True);(b/'sessions'/'old'/'old.json').write_text('prior conversation must remain untouched');p=b/'cline';p.write_bytes(base64.b64decode('${Buffer.from(source).toString('base64')}'));p.chmod(0o700)`);
 const config={host,cliPath:cli,storageMode:'native',sessionDirectory:sessions,remoteRoot:directory+'/control',responseTimeoutMs:5000};
 let client=createClient({mode:'live',connection:config}),id,stopped=false;
 try{
  assert.equal((await client.connect()).ready,true);
  id=(await client.start({cwd:directory+'/작업 폴더',prompt:'native prompt',terminalMode:'tui'})).executionId;
  let s=await until(client,s=>s.sessionId==='owned-native'&&s.messageInput?.ready);
  assert.equal(s.messages.at(-1).text,'NATIVE_READY');
  // A missing private-daemon witness must keep all owned children busy.
  const hubFile=config.remoteRoot+'/'+id+'/hub.json';
  python(`import pathlib\np=pathlib.Path(${JSON.stringify(hubFile)});p.rename(p.with_suffix('.held'))`);
  try{const blocked=await client.refresh();assert.equal(blocked.messageInput.ready,false);assert.equal(blocked.messageInput.reason,'agent-busy');}
  finally{python(`import pathlib\np=pathlib.Path(${JSON.stringify(hubFile)});p.with_suffix('.held').rename(p)`);}
  s=await until(client,s=>s.messageInput?.ready);
  assert.equal((await client.sendMessage({executionId:id,sessionId:s.sessionId,revision:s.revision,requestId:randomUUID(),text:'next'})).state,'delivered');
  client.disconnect();client.close();client=createClient({mode:'live',connection:config});await client.connect();await client.attach(id);
  s=await until(client,s=>s.messageInput?.ready);assert.equal(s.sessionId,'owned-native');assert.ok(s.messages.some(m=>m.text==='next'));
  assert.equal((await client.sendMessage({executionId:id,sessionId:s.sessionId,revision:s.revision,requestId:randomUUID(),text:'spawn'})).state,'delivered');
  s=await until(client,s=>s.executionEvidence.children.length>0);assert.equal(s.messageInput.ready,false);
  const result=await client.stop({executionId:id,requestId:randomUUID()});assert.equal(result.state,'confirmed');assert.deepEqual(result.remaining,[]);
  await until(client,()=>client.capabilities().resume);
  const resumed=await client.resume({executionId:id,requestId:randomUUID(),prompt:'resume native'});id=resumed.executionId;assert.equal(resumed.sessionId,'owned-native');assert.equal(resumed.resume.state,'delivered');
  await until(client,s=>s.messageInput?.ready&&s.messages.some(m=>m.text==='resume native'));
  assert.equal(python(`import pathlib;print(pathlib.Path(${JSON.stringify(sessions+'/old/old.json')}).read_text())`),'prior conversation must remain untouched');
 }finally{
  if(id){const r=await client.stop({executionId:id,requestId:randomUUID()});stopped=r.state==='confirmed';}client.close();
  if(!id||stopped)python(`import pathlib,shutil\np=pathlib.Path(${JSON.stringify(directory)}).resolve();assert p.parent==pathlib.Path('/tmp') and p.name.startswith('cline-sdk-native-test-');shutil.rmtree(p)`);
 }
});
