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
  cliVersion: "3.0.69",
  cliHash: "8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032",
  bootId: "boot-1",
};
function external(t, answer) {
  t.mock.method(childProcess, "spawn", () => {
    const p = new EventEmitter();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin = new PassThrough();
    p.kill = () => {};
    let raw = "";
    p.stdin.on("data", (d) => (raw += d));
    p.stdin.on("finish", () => {
      p.stdout.end(JSON.stringify(answer(JSON.parse(raw))));
      queueMicrotask(() => p.emit("close", 0));
    });
    return p;
  });
}
test("consumer sees stopped only after owned CLI and child identities are confirmed gone; duplicate stop retains evidence", async (t) => {
  let phase = 0;
  external(t, (r) => {
    if (!r.action) return pinned;
    if (r.action === "start")
      return { executionId: r.executionId, remoteRoot: "/fixture/control" };
    const stop = {
      requestId: "stop-1",
      executionId: r.executionId,
      state: "confirmed",
      childrenVerified: true,
      trackedCount: 3,
      remaining: [],
      reason: null,
      observedAt: "2026-10-09T00:00:00Z",
    };
    if (r.action === "stop") {
      phase++;
      return stop;
    }
    return {
      executionId: r.executionId,
      sessionId: "session-1",
      cursor: 0,
      observations: [],
      process: {
        kind: "process",
        identity: { pid: 42, startTime: "100", bootId: "boot-1" },
        alive: phase === 0,
        identityConfirmed: true,
        exitCode: phase ? -15 : null,
        manifestStatus: phase ? "cancelled" : "pending",
        stop: phase ? stop : null,
      },
    };
  });
  const client = createClient({
    mode: "live",
    connection: { host: "fixture" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture", prompt: "long command" });
  await client.refresh();
  const req = {
    executionId: client.snapshot().executionId,
    requestId: "stop-1",
  };
  const receipt = await client.stop(req);
  assert.equal(receipt.state, "confirmed");
  assert.equal(client.snapshot().execution, "stopped");
  assert.equal(client.snapshot().stop.childrenVerified, true);
  assert.deepEqual(await client.stop(req), receipt);
  client.close();
});
test("stop failures and stale process evidence never report completed or stopped, and another execution is rejected", async (t) => {
  external(t, (r) => {
    if (!r.action) return pinned;
    if (r.action === "start")
      return { executionId: r.executionId, remoteRoot: "/fixture/control" };
    if (r.action === "stop")
      return {
        requestId: r.requestId,
        executionId: r.executionId,
        state: "unknown",
        childrenVerified: false,
        trackedCount: 2,
        remaining: [{ pid: 43, startTime: "101", bootId: "boot-1" }],
        reason: "termination-timeout",
        observedAt: "2026-10-09T00:00:00Z",
      };
    return {
      executionId: r.executionId,
      cursor: 0,
      observations: [],
      process: {
        kind: "process",
        identity: { pid: 42, startTime: "100", bootId: "boot-1" },
        alive: false,
        identityConfirmed: true,
        exitCode: 0,
        manifestStatus: "completed",
      },
    };
  });
  const client = createClient({
    mode: "live",
    connection: { host: "fixture" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture", prompt: "long command" });
  assert.throws(
    () => client.stop({ executionId: "someone-else", requestId: "bad" }),
    { code: "wrong-stop-target" },
  );
  const result = await client.stop({
    executionId: client.snapshot().executionId,
    requestId: "failed-stop",
  });
  assert.equal(result.state, "unknown");
  assert.equal(client.snapshot().execution, "unknown");
  assert.equal(client.snapshot().stop.remaining.length, 1);
  client.close();
});
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
