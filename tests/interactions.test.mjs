import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@cline-cli-sdk/sdk";
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

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
test("conclusive prewrite rejection remains not submitted and restores a current response control", async (t) => {
  const record = await fixture("choice");
  let attempts = 0;
  boundary(t, (request) => {
    if (!request.action) return pinned;
    if (request.action === "start")
      return {
        executionId: request.executionId,
        remoteRoot: "/fixture/control",
      };
    if (request.action === "status")
      return status(request, record, request.cursor, 18);
    if (request.action === "respond") {
      attempts++;
      return { state: "rejected", reason: "terminal-observation-changed" };
    }
    throw new Error("unexpected action");
  });
  const client = createClient({
    mode: "live",
    connection: { host: "fixture" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "controlled" });
  await client.refresh();
  const s = client.snapshot();
  await assert.rejects(
    client.respond({
      sessionId: s.sessionId,
      executionId: s.executionId,
      interactionId: s.interaction.id,
      revision: s.revision,
      requestId: "prewrite-1",
      answer: "BLUE",
    }),
    { code: "input-rejected" },
  );
  assert.equal(client.snapshot().response.state, "not-submitted");
  assert.equal(client.snapshot().interaction.state, "awaiting-response");
  assert.equal(client.snapshot().connection, "connected");
  assert.equal(attempts, 1);
  client.close();
});
test("a live prompt without matching tool history remains explicitly unsupported", async (t) => {
  const record = await fixture("choice");
  record.observations = record.observations.filter((o) => o.kind === "pty");
  boundary(t, (request) => {
    if (!request.action) return pinned;
    if (request.action === "start")
      return {
        executionId: request.executionId,
        remoteRoot: "/fixture/control",
      };
    if (request.action === "status")
      return status(request, record, request.cursor, 18);
    throw new Error("unexpected action");
  });
  const client = createClient({
    mode: "live",
    connection: { host: "fixture" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "controlled" });
  await client.refresh();
  assert.equal(client.snapshot().interaction.state, "unsupported");
  assert.equal(client.snapshot().execution, "unknown");
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
  });
  const client = createClient({ mode: "replay" });
  await client.openReplay(record);
  await client.replayAll();
  assert.equal(client.snapshot().execution, "stopped");
  client.close();
});
test("wrong targets, stale revisions, changed duplicate answers and free text are rejected before input", async (t) => {
  const record = await fixture("choice");
  let writes = 0;
  boundary(t, (request) => {
    if (!request.action) return pinned;
    if (request.action === "start")
      return {
        executionId: request.executionId,
        remoteRoot: "/fixture/control",
      };
    if (request.action === "status")
      return status(request, record, request.cursor, 18);
    if (request.action === "respond") {
      writes++;
      return { state: "queued" };
    }
    throw new Error("unexpected action");
  });
  const client = createClient({
    mode: "live",
    connection: { host: "fixture" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "controlled" });
  await client.refresh();
  const s = client.snapshot();
  const request = {
    sessionId: s.sessionId,
    executionId: s.executionId,
    interactionId: s.interaction.id,
    revision: s.revision,
    requestId: "reject-1",
    answer: "RED",
  };
  await assert.rejects(client.respond({ ...request, sessionId: "another" }), {
    code: "response-target-mismatch",
  });
  await assert.rejects(client.respond({ ...request, executionId: "another" }), {
    code: "response-target-mismatch",
  });
  await assert.rejects(client.respond({ ...request, interactionId: "past" }), {
    code: "stale-interaction",
  });
  await assert.rejects(
    client.respond({ ...request, revision: s.revision - 1 }),
    { code: "stale-revision" },
  );
  await assert.rejects(
    client.respond({ ...request, answer: "2 custom 한글" }),
    { code: "unsupported-answer" },
  );
  assert.equal(writes, 0);
  client.close();
});
test("denying a tool delivers the rejection and exposes the recovery question as a separate stage", async (t) => {
  const record = await fixture("deny");
  let position = 28,
    writes = [];
  boundary(t, (request) => {
    if (!request.action) return pinned;
    if (request.action === "start")
      return {
        executionId: request.executionId,
        remoteRoot: "/fixture/control",
      };
    if (request.action === "respond") {
      writes.push(request);
      position = 36;
      return { state: "queued" };
    }
    if (request.action === "status") {
      const result = status(request, record, request.cursor, position);
      result.requests = writes.map((w) => ({
        requestId: w.requestId,
        state: "written",
      }));
      return result;
    }
    throw new Error("unexpected action");
  });
  const client = createClient({
    mode: "live",
    connection: { host: "fixture" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "controlled deny" });
  await client.refresh();
  const events = [];
  client.subscribe((event) => events.push(event));
  const s = client.snapshot();
  const result = await client.respond({
    sessionId: s.sessionId,
    executionId: s.executionId,
    interactionId: s.interaction.id,
    revision: s.revision,
    requestId: "deny-1",
    answer: "Deny",
  });
  assert.equal(result.state, "delivered");
  const receipt = events.find(
    (event) =>
      event.type === "response.changed" && event.payload.state === "delivered",
  );
  assert.equal(receipt.interactionId, s.interaction.id);
  assert.equal(receipt.payload.interactionId, s.interaction.id);
  assert.equal(receipt.requestId, "deny-1");
  assert.equal(Buffer.from(writes[0].dataBase64, "base64").toString(), "n\r");
  assert.equal(client.snapshot().interaction.kind, "recovery");
  assert.notEqual(client.snapshot().interaction.id, s.interaction.id);
  assert.deepEqual(client.snapshot().interaction.choices, [
    "Try a different approach",
    "Stop this run",
  ]);
  client.close();
});
const pinned = {
  platform: "Linux",
  python: true,
  pty: true,
  tmux: "tmux 3.4",
  cliPath: "/fixture/cline",
  cliVersion: "3.0.69",
  cliHash: "8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032",
  bootId: "boot-1",
};
function boundary(t, handler) {
  t.mock.method(childProcess, "spawn", () => {
    const p = new EventEmitter();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin = new PassThrough();
    p.kill = () => {};
    let input = "";
    p.stdin.on("data", (data) => (input += data));
    p.stdin.on("finish", () => {
      const value = handler(JSON.parse(input));
      p.stdout.end(JSON.stringify(value));
      queueMicrotask(() => p.emit("close", 0, null));
    });
    return p;
  });
}
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
test("consumer choice response waits for same-tool result and duplicate request never repeats input", async (t) => {
  const record = await fixture("choice");
  let position = 18,
    writes = [];
  boundary(t, (request) => {
    if (!request.action) return pinned;
    if (request.action === "start")
      return {
        executionId: request.executionId,
        remoteRoot: "/fixture/control",
      };
    if (request.action === "respond") {
      writes.push(request);
      position = 30;
      return { state: "queued" };
    }
    if (request.action === "status") {
      const result = status(request, record, request.cursor, position);
      result.requests = writes.map((w) => ({
        requestId: w.requestId,
        state: "written",
      }));
      return result;
    }
    throw new Error("unexpected boundary action");
  });
  const client = createClient({
    mode: "live",
    connection: { host: "fixture" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "controlled color" });
  await client.refresh();
  const before = client.snapshot();
  const request = {
    sessionId: before.sessionId,
    executionId: before.executionId,
    interactionId: before.interaction.id,
    revision: before.revision,
    requestId: "choice-1",
    answer: "BLUE",
  };
  const first = client.respond(request),
    duplicate = client.respond(request);
  await assert.rejects(
    client.respond({ ...request, requestId: "racing-other-id" }),
    { code: "response-busy" },
  );
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(a.state, "delivered");
  assert.deepEqual(a, b);
  assert.equal(writes.length, 1);
  assert.equal(Buffer.from(writes[0].dataBase64, "base64").toString(), "2\r");
  assert.equal(client.snapshot().messages.at(-1).text, "CHOSEN:BLUE");
  assert.equal(client.snapshot().response.state, "delivered");
  await assert.rejects(client.respond({ ...request, answer: "RED" }), {
    code: "request-conflict",
  });
  assert.equal(writes.length, 1);
  client.close();
});
test("transport loss while submitting preserves delivery unknown and never resends", async (t) => {
  const record = await fixture("choice");
  let writes = 0;
  boundary(t, (request) => {
    if (!request.action) return pinned;
    if (request.action === "start")
      return {
        executionId: request.executionId,
        remoteRoot: "/fixture/control",
      };
    if (request.action === "status")
      return status(request, record, request.cursor, 18);
    if (request.action === "respond") {
      writes++;
      return {
        error: "ssh-failed",
        message:
          "fault injection: acknowledgment lost after handing input to transport",
      };
    }
    throw new Error("unexpected action");
  });
  const client = createClient({
    mode: "live",
    connection: { host: "fixture" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "controlled" });
  await client.refresh();
  const s = client.snapshot();
  const request = {
    sessionId: s.sessionId,
    executionId: s.executionId,
    interactionId: s.interaction.id,
    revision: s.revision,
    requestId: "uncertain-1",
    answer: "BLUE",
  };
  await assert.rejects(client.respond(request), { code: "ssh-failed" });
  assert.equal(client.snapshot().response.state, "delivery-unknown");
  assert.equal(client.snapshot().connection, "disconnected");
  await assert.rejects(client.respond(request), { code: "ssh-failed" });
  await assert.rejects(client.respond({ ...request, requestId: "retry-2" }), {
    code: "response-busy",
  });
  assert.equal(writes, 1);
  client.close();
});
