import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@cline-cli-sdk/sdk";
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import {createHash} from 'node:crypto';

const fixture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`../fixtures/interactions/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
test("an anchored unanswered recovery survives the measured late stdout redraw, but not a new phase", async () => {
  const record = await fixture("deny");
  const continuation = record.observations.filter((o) => o.seq > 36);
  record.observations = record.observations.filter((o) => o.seq <= 36);
  const client = createClient({ mode: "replay" });
  await client.openReplay(record);
  await client.replayAll();
  const active = client.snapshot().interaction;
  assert.equal(active.kind, "recovery");
  record.observations.push(...continuation.filter((o) => o.seq <= 41));
  await client.openReplay(record);
  await client.replayAll();
  assert.equal(client.snapshot().interaction.kind, "recovery");
  assert.equal(client.snapshot().interaction.id, active.id);
  record.observations.push(...continuation.filter((o) => o.seq > 41));
  await client.openReplay(record);
  await client.replayAll();
  assert.equal(client.snapshot().interaction, null);
  client.close();
});
test("public replay distinguishes tool approval from its same-tool choice question", async () => {
  const record = await fixture("choice");
  const client = createClient({ mode: "replay" });
  await client.openReplay(record);
  while (
    client.snapshot().replay.position <
    record.observations.findIndex((o) => o.seq > 12)
  )
    await client.nextObservation();
  const approval = client.snapshot().interaction;
  assert.equal(approval.kind, "approval");
  assert.deepEqual(approval.choices, ["Approve", "Deny"]);
  assert.ok(approval.toolId);
  while (
    client.snapshot().replay.position <
    record.observations.findIndex((o) => o.seq > 18)
  )
    await client.nextObservation();
  const question = client.snapshot().interaction;
  assert.equal(question.kind, "question");
  assert.deepEqual(question.choices, ["RED", "BLUE"]);
  assert.equal(question.toolId, approval.toolId);
  assert.notEqual(question.id, approval.id);
  client.close();
});
test("witnessed process exit after accepted stop-recovery is stopped even when old planning text and manifest say completed", async () => {
  const record = await fixture("deny");
  record.observations.push({
    kind: "process",
    seq: 48,
    observedAt: "2026-10-09T00:00:50Z",
    identity: { pid: 42, startTime: "100", bootId: "fixture-boot" },
    alive: false,
    identityConfirmed: true,
    exitCode: 0,
    manifestStatus: "completed",
    requestedStop: true,
    // Injected whole-tree verification; original recording measured CLI exit only.
    childrenVerified: true,
    children: [],
  });
  const client = createClient({ mode: "replay" });
  await client.openReplay(record);
  await client.replayAll();
  assert.equal(client.snapshot().execution, "stopped");
  client.close();
});
const pinned = {
  platform: "Linux",
  python: true,
  pty: true,
  tmux: "tmux 3.4",
  cliPath: "/fixture/cline",
  cliVersion: "3.0.69", cliFlags:['--cwd','--data-dir','--auto-approve','--tui','--id','--json','--retries','--zen'],
  cliHash: "8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032",
  bootId: "boot-1",
};
function status(request, record, from, to) {
  return {
    executionId: request.executionId,
    sessionId: record.sessionId,
    cursor: to,
    observations: record.observations.filter(
      (o) => o.seq > from && o.seq <= to,
    ),
    process: {
      identity: { pid: 42, startTime: "100", bootId: "boot-1" },
      alive: true,
      identityConfirmed: true,
      exitCode: null,
      manifestStatus: "pending",
    },
  };
}
