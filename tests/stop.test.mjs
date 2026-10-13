import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createClient } from "@cline-cli-sdk/sdk";
import { readFile } from "node:fs/promises";

const pinned = {
  platform: "Linux",
  pty: true,
  tmux: "tmux 3.4",
  cliPath: "/fixture/cline",
  cliVersion: "3.0.69", cliFlags:['--cwd','--data-dir','--auto-approve','--tui','--id','--json','--retries','--zen'],
  cliHash: "8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032",
  bootId: "boot-1",
};
test("a cancelled manifest with a still-running command is not a completed stop", async () => {
  const client = createClient({ mode: "replay" });
  await client.openReplay({
    schemaVersion: 1,
    cli: { name: "cline", version: "3.0.69", profile: "cline-3.0.69-readline" },
    terminal: { rows: 40, cols: 120 },
    sessionId: "session-1",
    executionId: "run-1",
    observations: [
      {
        kind: "process",
        seq: 1,
        observedAt: "2026-10-09T00:00:00Z",
        identity: { pid: 42, startTime: "100", bootId: "boot-1" },
        alive: false,
        identityConfirmed: true,
        exitCode: -15,
        manifestStatus: "cancelled",
        childrenVerified: false,
        children: [{ pid: 43, startTime: "101", bootId: "boot-1" }],
      },
    ],
    provenance: {
      source: "fault-injection",
      sourceSha256: "",
      review:
        "Cancelled CLI with residual child is injected, not a measured failure.",
      transformations: [],
      complete: true,
      truncated: false,
    },
  });
  await client.replayAll();
  assert.equal(client.snapshot().execution, "unknown");
  client.close();
});
test("offline replay refuses a stop without remote side effects", async () => {
  const client = createClient({ mode: "replay" });
  await assert.rejects(
    client.stop({ executionId: "run-1", requestId: "offline-stop" }),
    { code: "replay-read-only" },
  );
  client.close();
});
test("observed CLI plus Python and sleep termination replays through the public process observation contract", async () => {
  const recording = JSON.parse(
    await readFile(
      new URL("../fixtures/stop/owned-child-stop.json", import.meta.url),
      "utf8",
    ),
  );
  const client = createClient({ mode: "replay" });
  await client.openReplay(recording);
  await client.nextObservation();
  assert.equal(client.snapshot().execution, "running");
  assert.equal(client.snapshot().executionEvidence.children.length, 2);
  await client.nextObservation();
  assert.equal(client.snapshot().execution, "stopped");
  assert.equal(client.snapshot().stop.targets.length, 3);
  assert.deepEqual(client.snapshot().stop.remaining, []);
  client.close();
});
