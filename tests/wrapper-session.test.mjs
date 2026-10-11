import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createClient} from '@cline-cli-sdk/sdk';

// Opt-in real Linux/OpenSSH/PTY seam. Uses a test-owned launcher and native child,
// no installed Cline, model provider, credentials or user settings.
const host=process.env.CLINE_SDK_TEST_SSH_HOST;
function python(source) {
 const r=spawnSync('ssh',[host,`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))"`],{encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stderr);return r.stdout.trim();
}
async function until(read,accept) {
 for(let i=0;i<15;i++){const value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,100));}
 throw new Error('Expected managed child session/history within bounded refreshes');
}

test('real SSH binds a launcher child session, permits idle input and stops every owned process', {skip:!host,timeout:90000},async()=>{
 const directory=python("import tempfile;print(tempfile.mkdtemp(prefix='cline-sdk-wrapper-test-'))");
 assert.match(directory,/^\/tmp\/cline-sdk-wrapper-test-[\w-]+$/);
 const cli=directory+'/cline', root=directory+'/control';
 const source=`#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys,time,tty
base=pathlib.Path(__file__).parent
if '--help' in sys.argv:
 print('--cwd --data-dir --auto-approve --tui');sys.exit(0)
if '--native-child' not in sys.argv:
 sys.exit(subprocess.call([sys.executable,__file__,'--native-child',*sys.argv[1:]]))
tty.setraw(sys.stdin.fileno())
data=pathlib.Path(sys.argv[sys.argv.index('--data-dir')+1]);sid='wrapper-child-session'
folder=data/'sessions'/sid;folder.mkdir(parents=True)
(folder/(sid+'.json')).write_text(json.dumps(dict(session_id=sid,pid=os.getpid(),status='idle')))
messages=[dict(id='first',role='user',content=[dict(type='text',text='wrapper prompt')]),dict(id='reply',role='assistant',content=[dict(type='text',text='WRAPPER_CHILD_OK')])]
def history():
 p=folder/(sid+'.messages.json');tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(dict(version=1,sessionId=sid,messages=messages)));tmp.replace(p)
def screen(text=''):
 rule='─'*120
 sys.stdout.write('\\x1b[2J\\x1b[35;1H'+rule+'\\x1b[36;1H❯ '+(text or 'Ask anything...')+'\\x1b[37;1H'+rule+'\\x1b[38;1H● Act (Tab)\\x1b[40;1HAuto-approve all disabled (Shift+Tab)'+f'\\x1b[36;{3+len(text)}H');sys.stdout.flush()
history();screen();text='';count=0
while True:
 value=os.read(sys.stdin.fileno(),64).decode('utf8')
 if '\\r' in value:
  count+=1
  if text=='spawn':subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])
  messages.extend([dict(id='user-'+str(count),role='user',content=[dict(type='text',text=text)]),dict(id='reply-'+str(count),role='assistant',content=[dict(type='text',text='CHILD_REPLY')])]);history();text=''
 else:text+=value
 screen(text)
`;
 python(`import pathlib,base64\np=pathlib.Path(${JSON.stringify(cli)});p.write_bytes(base64.b64decode('${Buffer.from(source).toString('base64')}'));p.chmod(0o700)`);
 const c=createClient({mode:'live',connection:{host,cliPath:cli,remoteRoot:root,responseTimeoutMs:5000}});
 let executionId, stopped=false;
 try {
  assert.equal((await c.connect()).ready,true);
  executionId=(await c.start({cwd:directory,dataDir:directory+'/data',terminalMode:'tui',prompt:'wrapper prompt'})).executionId;
  const state=await until(()=>c.refresh(),s=>s.sessionId==='wrapper-child-session'&&s.messages.some(m=>m.text==='WRAPPER_CHILD_OK'));
  assert.equal(state.historySync.current,true);
  await until(()=>c.refresh(),()=>c.capabilities().sendMessage);
  assert.deepEqual(c.snapshot().executionEvidence.children,[]);
  // Test-owned evidence only: foreign launcher, reused child PID/start time,
  // and incomplete tracking must never authorize input to the known session.
  const ownershipFile=root+'/'+executionId+'/ownership.json';
  const original=python(`import pathlib;print(pathlib.Path(${JSON.stringify(ownershipFile)}).read_text())`);
  try {
   for(const fault of ['foreign-launcher','reused-child','tracking-error']) {
    const changed=JSON.parse(original);
    if(fault==='foreign-launcher')changed.cliIdentity.startTime='0';
    if(fault==='reused-child')changed.owned.find(p=>p.pid!==changed.cliIdentity.pid).startTime='0';
    if(fault==='tracking-error')changed.trackingError='test-incomplete';
    python(`import pathlib,base64\np=pathlib.Path(${JSON.stringify(ownershipFile)});p.write_bytes(base64.b64decode('${Buffer.from(JSON.stringify(changed)).toString('base64')}'))`);
    await c.refresh();assert.equal(c.capabilities().sendMessage,false,fault);
    assert.equal(c.snapshot().executionEvidence.manifestStatus,null,fault);
    python(`import pathlib,base64\np=pathlib.Path(${JSON.stringify(ownershipFile)});p.write_bytes(base64.b64decode('${Buffer.from(original).toString('base64')}'))`);
    await until(()=>c.refresh(),()=>c.capabilities().sendMessage);
   }
  } finally {
   python(`import pathlib,base64\np=pathlib.Path(${JSON.stringify(ownershipFile)});p.write_bytes(base64.b64decode('${Buffer.from(original).toString('base64')}'))`);
  }
  const s=c.snapshot();
  const sent=await c.sendMessage({executionId,sessionId:s.sessionId,revision:s.revision,requestId:randomUUID(),text:'next'});
  assert.equal(sent.state,'delivered');assert.ok(c.snapshot().messages.some(m=>m.role==='user'&&m.text==='next'));
  await until(()=>c.refresh(),()=>c.capabilities().sendMessage);
  const next=c.snapshot();
  assert.equal((await c.sendMessage({executionId,sessionId:next.sessionId,revision:next.revision,requestId:randomUUID(),text:'spawn'})).state,'delivered');
  const busy=await until(()=>c.refresh(),s=>s.executionEvidence.children.length>0);
  assert.equal(busy.messageInput.reason,'agent-busy');assert.equal(c.capabilities().sendMessage,false);
 } finally {
  if(executionId){const result=await c.stop({executionId,requestId:randomUUID()});assert.equal(result.state,'confirmed');assert.equal(result.childrenVerified,true);assert.deepEqual(result.remaining,[]);stopped=true;}
  c.close();
  if(!executionId||stopped)python(`import pathlib,shutil\np=pathlib.Path(${JSON.stringify(directory)}).resolve();assert p.parent==pathlib.Path('/tmp') and p.name.startswith('cline-sdk-wrapper-test-');shutil.rmtree(p)`);
 }
});
