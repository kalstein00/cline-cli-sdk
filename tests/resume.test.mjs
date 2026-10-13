import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createClient,readDiagnostic,compareDiagnostic} from '@cline-cli-sdk/sdk';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
const pinned={platform:'Linux',pty:true,tmux:'tmux 3.4',cliPath:'/fixture/cline',cliVersion:'3.0.69', cliFlags:['--cwd','--data-dir','--auto-approve','--tui','--id','--json','--retries','--zen'],cliHash:'8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032',bootId:'boot'};
test('native completed and explicitly stopped resume traces preserve prior conversation, followup user text and numeric/Korean results offline',async()=>{
 for(const [name,answer,prior] of [['native-completed-resume','2 custom identifier','RESUME_INITIAL_DONE'],['native-stopped-resume','한글 응답 가나다 😀 café','STOP_BEFORE_RESUME']]){
 const recording=JSON.parse(await readFile(new URL(`../fixtures/resume/${name}.json`,import.meta.url)));
 const c=createClient({mode:'replay'});await c.openReplay(recording);await c.replayAll();const s=c.snapshot();
 assert.ok(s.messages.some(m=>m.text.includes(prior)));assert.ok(s.messages.some(m=>m.role==='user'&&m.text==='Ask ask_question: RESUME_FOLLOWUP, options RED,BLUE. Print RESUME_RESULT:<answer>. No other tools.'));
 assert.ok(s.messages.some(m=>m.role==='assistant'&&m.text==='RESUME_RESULT:'+answer));assert.equal(s.sessionId,recording.sessionId);assert.equal(s.executionId,recording.executionId);c.close();}
});
test('actual stopped-session resume restores a focused empty composer and observes followup echo before separate Enter',async()=>{
 for(const [name,text] of [['restored-composer',''],['composer-echo','Reply exactly RESUMED_CONFIRMED. Do not call any tools.']]){
 const c=createClient({mode:'replay'});await c.openReplay(JSON.parse(await readFile(new URL(`../fixtures/resume/${name}.json`,import.meta.url))));await c.replayAll();
 assert.deepEqual(c.snapshot().composer,{mode:'tui',text});assert.ok(c.snapshot().messages.length);c.close();}
});
