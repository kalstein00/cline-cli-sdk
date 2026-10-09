import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createClient } from "@cline-cli-sdk/sdk";
const pinned = {
  platform: "Linux",
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
    let text = "";
    p.stdin.on("data", (c) => (text += c));
    p.stdin.on("finish", () => {
      p.stdout.end(JSON.stringify(handler(JSON.parse(text))));
      queueMicrotask(() => p.emit("close", 0));
    });
    return p;
  });
}
const fixture = async () =>
  JSON.parse(
    await readFile(
      new URL("../fixtures/interactions/choice.json", import.meta.url),
    ),
  );
function observed(request, record, position, ledger) {
  return {
    executionId: request.executionId,
    sessionId: record.sessionId,
    cursor: position,
    observations: record.observations.filter(
      (o) => o.seq > request.cursor && o.seq <= position,
    ),
    management: { responseReservation: true },
    requests: ledger,
    process: {
      kind: "process",
      identity: { pid: 42, startTime: "100", bootId: "boot-1" },
      alive: true,
      identityConfirmed: true,
      exitCode: null,
      manifestStatus: "pending",
    },
  };
}
const fresh = () =>
  createClient({
    mode: "live",
    connection: { host: "fixture", remoteRoot: "/fixture/control" },
  });
const response = (client, requestId) => {
  const s = client.snapshot();
  return {
    sessionId: s.sessionId,
    executionId: s.executionId,
    interactionId: s.interaction.id,
    revision: s.revision,
    requestId,
    answer: "BLUE",
  };
};
test("fault-injected loss during reservation is conclusively before PTY write and never retries input", async (t) => {
  const record = await fixture();
  let writes = 0;
  boundary(t, (r) => {
    if (!r.action) return pinned;
    if (r.action === "start")
      return { executionId: r.executionId, remoteRoot: "/fixture/control" };
    if (r.action === "status") return observed(r, record, 18, []);
    if (r.action === "reserve-response")
      return {
        error: "ssh-failed",
        message:
          "fault injection: lost reservation acknowledgment before input operation",
      };
    if (r.action === "respond") {
      writes++;
      return { error: "ssh-failed", message: "input transport failed" };
    }
    throw Error("unexpected action " + r.action);
  });
  const c = fresh();
  await c.connect();
  await c.start({ cwd: "/fixture/work", prompt: "controlled" });
  await c.refresh();
  const req = response(c, "before-write");
  await assert.rejects(c.respond(req), { code: "ssh-failed" });
  assert.equal(c.snapshot().response.state, "not-submitted");
  assert.equal(writes, 0);
  c.close();
});
test("fault-injected uncertain write survives consumer restart, blocks another answer, then resolves only from correlated CLI history", async (t) => {
  const record = await fixture();
  let writes = 0,
    position = 18,
    runId,
    ledger = [];
  boundary(t, (r) => {
    if (!r.action) return pinned;
    if (r.action === "start") {
      runId = r.executionId;
      return { executionId: runId, remoteRoot: "/fixture/control" };
    }
    if (r.action === "list")
      return {
        executions: [
          {
            executionId: runId,
            remoteRoot: "/fixture/control",
            sessionId: record.sessionId,
            terminal: { rows: 40, cols: 120 },
          },
        ],
      };
    if (r.action === "status") return observed(r, record, position, ledger);
    if (r.action === "reserve-response") {
      ledger = [
        {
          requestId: r.requestId,
          state: "reserved",
          binding: Object.fromEntries(
            [
              "sessionId",
              "executionId",
              "interactionId",
              "revision",
              "toolId",
              "kind",
              "answerDigest",
            ].map((k) => [k, r[k]]),
          ),
        },
      ];
      return { state: "reserved" };
    }
    if (r.action === "respond") {
      writes++;
      ledger[0].state = "queued";
      return {
        error: "ssh-failed",
        message: "fault injection: write outcome unavailable",
      };
    }
    if (r.action === "settle-response") {
      ledger[0].resolution = r.resolution;
      return { settled: true };
    }
    throw Error("unexpected action " + r.action);
  });
  const first = fresh();
  await first.connect();
  await first.start({ cwd: "/fixture/work", prompt: "controlled" });
  await first.refresh();
  const req = response(first, "uncertain-write");
  await assert.rejects(first.respond(req), { code: "ssh-failed" });
  assert.equal(first.snapshot().response.state, "delivery-unknown");
  first.close();
  const next = fresh();
  await next.connect();
  const recovered = await next.attach(runId);
  assert.equal(recovered.response.state, "delivery-unknown");
  await assert.rejects(next.respond(response(next, "different-request")), {
    code: "response-busy",
  });
  assert.equal(writes, 1);
  position = 30;
  const confirmed = await next.reconfirmDelivery();
  assert.equal(confirmed.response.state, "delivered");
  const existing = await next.respond(req);
  assert.equal(existing.state, "delivered");
  assert.equal(writes, 1);
  await assert.rejects(next.respond({ ...req, answer: "RED" }), {
    code: "request-conflict",
  });
  next.close();
});
test("fault-injected loss after CLI accepts an approval resolves on the same-tool question without approving it again", async (t) => {
  const record = await fixture();
  let position = 12,
    runId,
    writes = 0,
    ledger = [];
  boundary(t, (r) => {
    if (!r.action) return pinned;
    if (r.action === "start") {
      runId = r.executionId;
      return { executionId: runId, remoteRoot: "/fixture/control" };
    }
    if (r.action === "list")
      return {
        executions: [
          {
            executionId: runId,
            remoteRoot: "/fixture/control",
            sessionId: record.sessionId,
            terminal: { rows: 40, cols: 120 },
          },
        ],
      };
    if (r.action === "status") return observed(r, record, position, ledger);
    if (r.action === "reserve-response") {
      ledger = [
        {
          requestId: r.requestId,
          state: "reserved",
          binding: Object.fromEntries(
            [
              "sessionId",
              "executionId",
              "interactionId",
              "revision",
              "toolId",
              "kind",
              "answerDigest",
            ].map((k) => [k, r[k]]),
          ),
        },
      ];
      return { state: "reserved" };
    }
    if (r.action === "respond") {
      writes++;
      ledger[0].state = "written";
      position = 18;
      return {
        error: "ssh-failed",
        message:
          "fault injection: acknowledgment lost after approval opened the actual question",
      };
    }
    if (r.action === "settle-response") {
      ledger[0].resolution = r.resolution;
      return { settled: true };
    }
    throw Error("unexpected action " + r.action);
  });
  const first = fresh();
  await first.connect();
  await first.start({ cwd: "/fixture/work", prompt: "controlled" });
  await first.refresh();
  const s = first.snapshot();
  const req = { ...response(first, "approval-ack-lost"), answer: "Approve" };
  await assert.rejects(first.respond(req), { code: "ssh-failed" });
  first.close();
  const restarted = fresh();
  await restarted.connect();
  const restored = await restarted.attach(runId);
  assert.equal(restored.response.state, "delivered");
  assert.equal(restored.response.interactionId, s.interaction.id);
  assert.equal(restored.interaction.kind, "question");
  assert.equal(restored.interaction.state, "awaiting-response");
  assert.notEqual(restored.interaction.id, s.interaction.id);
  await restarted.respond(req);
  assert.equal(writes, 1);
  restarted.close();
});
