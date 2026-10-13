import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';

import cp from 'node:child_process';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {readDiagnostic,compareDiagnostic} from '@cline-cli-sdk/sdk';

test('actual same-run followup observations replay delivery and preserve repeated requests as distinct user messages',async()=>{
 const r=JSON.parse(await readFile(new URL('../fixtures/chat/followup.json',import.meta.url))),c=createClient({mode:'replay'});await c.openReplay(r);const delivered=[];
 c.subscribe(e=>{const d=e.payload?.messageDelivery;if(d?.state==='delivered')delivered.push(d);});await c.replayAll();
 assert.equal(delivered.length,4);assert.equal(new Set(delivered.map(d=>d.messageId)).size,4);assert.equal(new Set(delivered.map(d=>d.executionId)).size,1);
 assert.equal(c.snapshot().messages.filter(m=>m.role==='user'&&m.text==='Reply exactly API_SAME. No tools.').length,2);
 assert.ok(c.snapshot().messages.some(m=>m.text==='2 한글 😀 café: Reply exactly API_ONE. No tools.'));assert.equal(c.snapshot().execution,'running');c.close();
});
