import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,readDiagnostic} from '@cline-cli-sdk/sdk';
import {directRemote} from './support/direct-ssh.mjs';
import {shellArg,tmuxArg} from '../packages/sdk/dist/ssh.js';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const client=()=>createClient({mode:'live',connection:{host:'fixture'}});
test('pane observations notify subscribers and advance revision only when changed',async t=>{
 const fixture={screen:'first screen'};directRemote(t,fixture);const c=client();t.after(()=>c.close());
 await c.connect();await c.start({cwd:'/work',prompt:'first'});await c.refresh();
 const events=[];c.subscribe(event=>events.push(event));const before=c.snapshot().revision;
 fixture.screen='second screen';fixture.pane='%0\t456\t100\t32\t1\t0\n';
 const changed=await c.refresh();assert.ok(changed.revision>before);
 const event=events.find(event=>event.payload?.remoteObservation?.terminalText==='second screen');
 assert.ok(event);assert.equal(event.revision,changed.revision);assert.equal(changed.execution,'unknown');
 await c.refresh();assert.equal(c.snapshot().revision,changed.revision);assert.equal(events.length,1);
});
test('disconnect from the connecting event prevents all subsequent SSH work',async t=>{
 const remote=directRemote(t);const c=client();t.after(()=>c.close());
 c.subscribe(event=>{if(event.payload?.connection==='connecting')c.disconnect();});
 await assert.rejects(c.connect(),{code:'connection-interrupted'});
 assert.equal(remote.commands.length,0);assert.equal(c.snapshot().connection,'disconnected');
});
test('installed custom CLI preflight does not require Python, binary hash or a fixed layout',async t=>{
 const remote=directRemote(t);const c=client();t.after(()=>c.close());
 const report=await c.connect();assert.equal(report.ready,true);assert.equal(report.python,false);
 assert.equal(report.processOwnership,false);assert.equal(report.cliHash,null);assert.equal(report.storageMode,'native');
 assert.equal(report.profile.companyCompatibility,'unverified');
 assert.ok(remote.commands.every(c=>c.stdin===''&&!/python|base64|supervisor|exec\(/i.test(c.command)));
 for(const command of remote.commands){assert.ok(command.args.includes('StrictHostKeyChecking=yes'));assert.ok(command.args.includes('BatchMode=yes'));}
});
test('all unsafe controls reject before connecting or sending any command',async t=>{
 const remote=directRemote(t);const c=client();t.after(()=>c.close());
 for(const method of ['sendMessage','respond','resume','stop']){
  await assert.rejects(c[method]({}),{code:'remote-input-disabled',notSubmitted:true});assert.equal(c.capabilities()[method==='respond'?'responses':method],false);
 }
 assert.equal(remote.commands.length,0);assert.equal(c.snapshot().messageInput.ready,false);
});
test('colored help on stderr supports custom CLI flags without requiring stdout',async t=>{
 directRemote(t,{intercept:command=>command.endsWith(' --help')?{stderr:'\x1b[32m--cwd\x1b[0m --auto-approve --tui'}:undefined});
 const c=client();t.after(()=>c.close());const report=await c.connect();assert.equal(report.ready,true);assert.deepEqual(report.help.channels,['stderr']);
});
test('tmux inventory failure is not silently converted into an empty execution list',async t=>{
 directRemote(t,{intercept:command=>command.includes("'list-sessions'")?{code:1,stderr:'permission denied'}:undefined});
 const c=client();t.after(()=>c.close());await c.connect();await assert.rejects(c.listManagedExecutions(),{code:'remote-command-failed'});
});
test('launch uses separate CLI argv, disables automatic approval and reserves one execution',async t=>{
 const remote=directRemote(t);const c=client();t.after(()=>c.close());await c.connect();
 const prompt="한국어 'quoted' $(touch /tmp/no) `no`;";
 const started=await c.start({cwd:'/work dir',prompt,terminal:{cols:80,rows:24},terminalMode:'tui'});
 const launch=remote.commands.find(c=>c.command.includes("'new-session'"));
 assert.ok(launch.command.includes("'/installed/cline' '--cwd' '/work dir' '--auto-approve' 'false' '--tui' '--' "+tmuxArg(prompt)));
 assert.ok(launch.command.indexOf("'remain-on-exit'")<launch.command.indexOf("'new-session'"));
 assert.equal(started.remoteObservation.launchState,'tmux-created');
 await assert.rejects(c.start({cwd:'/work',prompt:'duplicate'}),{code:'managed-execution-selected'});
 const state=await c.refresh();assert.deepEqual(state.remoteObservation.terminal,{cols:80,rows:24});
 assert.equal(state.execution,'unknown');assert.equal(state.executionEvidence,null);assert.equal(state.messageInput.ready,false);
 c.disconnect();assert.equal(remote.commands.filter(c=>/kill-session|kill-server|send-keys|respawn/.test(c.command)).length,0);
});
test('shell and tmux quoting keep separators and substitutions literal',()=>{
 assert.equal(shellArg("a'b"),"'a'\\''b'");assert.equal(tmuxArg('x;'),"'x\\;'");
 assert.equal(tmuxArg('x\\;'),"'x\\\\;'");assert.equal(tmuxArg('x; y'),"'x; y'");
 assert.throws(()=>shellArg('x\0'),{code:'invalid-argument'});
});
test('disconnect during initialization cannot launch a CLI after detaching',async t=>{
 const remote=directRemote(t);const c=client();t.after(()=>c.close());await c.connect();
 let detached=false;c.subscribe(event=>{if(event.executionId&&!detached){detached=true;c.disconnect();}});
 await assert.rejects(c.start({cwd:'/work',prompt:'do not launch'}),{code:'connection-interrupted'});
 assert.equal(remote.commands.some(c=>c.command.includes("'new-session'")),false);
 assert.equal(c.snapshot().connection,'disconnected');
});
test('launch timeout/SSH failure never retries and does not claim delivery',async t=>{
 const remote=directRemote(t,{launchCode:255});const c=client();t.after(()=>c.close());await c.connect();
 await assert.rejects(c.start({cwd:'/work',prompt:'first'}),{code:'ssh-failed',deliveryUnknown:true});
 assert.equal(c.snapshot().remoteObservation.launchState,'unknown');
 await c.connect();await assert.rejects(c.start({cwd:'/work',prompt:'repeat'}),{code:'managed-execution-selected'});
 assert.equal(remote.commands.filter(c=>c.command.includes("'new-session'")).length,1);
});
test('saved JSON sessions are explicitly selected, never matched by recency or claimed as owned',async t=>{
 const remote=directRemote(t);const c=client();t.after(()=>c.close());await c.connect();
 const list=await c.listManagedExecutions();assert.equal(list[0].executionId,'history:saved-chat');assert.equal(list[0].identityConfirmed,false);
 await c.attach(list[0].executionId);assert.equal(c.snapshot().messages[0].text,'Prior conversation');
 assert.equal(c.snapshot().execution,'unknown');assert.equal(c.snapshot().remoteObservation.kind,'history');
 assert.ok(!remote.commands.some(c=>/new-session|send-keys|kill-pane/.test(c.command)));
 remote.setHistory('{partial');await c.refresh();assert.equal(c.snapshot().historySync.current,false);assert.equal(c.snapshot().messages[0].text,'Prior conversation');
 remote.setHistory(JSON.stringify({version:1,sessionId:'wrong',messages:[]}));await c.refresh();assert.equal(c.snapshot().historySync.current,false);
 remote.setHistory(JSON.stringify({version:1,sessionId:'saved-chat',messages:[{id:'u1',role:'user',content:[{type:'text',text:'Updated'}]}]}));
 await c.refresh();assert.equal(c.snapshot().historySync.current,true);assert.equal(c.snapshot().messages.length,1);assert.equal(c.snapshot().messages[0].text,'Updated');
 await assert.rejects(c.attach('history:../../private'),{code:'unknown-execution'});
});
test('reconnection lists only versioned direct sessions, and closed clients cannot run commands',async t=>{
 const remote=directRemote(t);const c=client();await c.connect();const started=await c.start({cwd:'/work',prompt:'first'});c.close();
 const before=remote.commands.length;await assert.rejects(c.preflight(),{code:'client-closed'});assert.equal(remote.commands.length,before);
 remote.runs.set('sdk-00000000-0000-0000-0000-000000000000',Buffer.from(JSON.stringify({version:99})).toString('base64'));
 const next=client();t.after(()=>next.close());await next.connect();
 const runs=await next.listManagedExecutions();assert.equal(runs.filter(r=>r.kind==='tmux').length,1);
 await next.attach(started.executionId);assert.equal(next.snapshot().messageInput.ready,false);assert.equal(next.snapshot().sessionId,null);
});
test('missing required options, old tmux, invalid geometry and unsupported modes fail before launch',async t=>{
 const remote=directRemote(t,{help:'--cwd',tmux:'tmux 2.9'});const c=client();t.after(()=>c.close());
 assert.equal((await c.connect()).ready,false);await assert.rejects(c.start({cwd:'/work',prompt:'hi'}),{code:'prerequisites-unavailable'});
 assert.equal(remote.commands.some(c=>c.command.includes('new-session')),false);
});
test('validation rejects unsafe cwd formats, option injection and disabled output before creating a pane',async t=>{
 const remote=directRemote(t);const c=client();t.after(()=>c.close());await c.connect();
 for(const request of [{cwd:'/work',prompt:'x',terminal:{rows:1,cols:1}},{cwd:'/work/#(id)',prompt:'x'},{cwd:'/missing',prompt:'x'}])
  await assert.rejects(c.start(request),{code:'invalid-task'});
 for(const extra of [{dataDir:'/data'},{outputMode:'json'},{resultFormat:{type:'json',requestId:'x'}}])
  await assert.rejects(c.start({cwd:'/work',prompt:'x',...extra}),{code:'unsupported-direct-mode'});
 assert.equal(remote.commands.some(c=>c.command.includes('new-session')),false);
 assert.throws(()=>createClient({mode:'live',connection:{host:'-oProxyCommand=evil'}}),{code:'invalid-connection'});
});
test('ambiguous panes and unbounded terminal geometry are not interpreted as safe controls',async t=>{
 directRemote(t,{pane:'%0\t456\t900\t24\t0\t\n'});const c=client();t.after(()=>c.close());await c.connect();await c.start({cwd:'/work',prompt:'hi'});
 await assert.rejects(c.refresh(),{code:'execution-unconfirmed'});assert.equal(c.capabilities().stop,false);
});
test('direct diagnostics are explicitly partial and starting collection does not erase saved messages',async t=>{
 directRemote(t);const directory=await mkdtemp(join(tmpdir(),'cline-direct-diag-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const c=client();t.after(()=>c.close());await c.connect();await c.attach('history:saved-chat');
 await c.startDiagnostics({directory});assert.equal(c.snapshot().messages.length,1);await c.refresh();const status=await c.stopDiagnostics();
 const bundle=await readDiagnostic(status.path);assert.equal(bundle.recording.provenance.complete,false);
 assert.ok(bundle.recording.observations.some(o=>o.kind==='history'));
 const pkg=JSON.parse(await readFile(new URL('../packages/sdk/package.json',import.meta.url)));assert.deepEqual(pkg.files,['dist']);
});
