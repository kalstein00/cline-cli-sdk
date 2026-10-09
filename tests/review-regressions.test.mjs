import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@cline-cli-sdk/sdk';

test('completion requires current complete descendant and supervisor termination evidence', async () => {
  const original = JSON.parse(await readFile(new URL('../fixtures/live-completion.json', import.meta.url), 'utf8'));
  for (const missing of [
    { childrenVerified: false, children: [], trackingError: 'owned-process-limit', supervisorAlive: true },
    { childrenVerified: false, children: [], supervisorAlive: false },
    { childrenVerified: true, children: [], supervisorAlive: true },
  ]) {
    const record = structuredClone(original);
    Object.assign(record.observations.at(-1), missing);
    const client = createClient({ mode: 'replay' });
    await client.openReplay(record);
    await client.replayAll();
    assert.equal(client.snapshot().execution, 'unknown');
    client.close();
  }
  const confirmed = structuredClone(original);
  Object.assign(confirmed.observations.at(-1), { childrenVerified: true, children: [], supervisorAlive: false, trackingError: null });
  const client = createClient({ mode: 'replay' });
  await client.openReplay(confirmed);
  await client.replayAll();
  assert.equal(client.snapshot().execution, 'completed');
  client.close();
});
