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
