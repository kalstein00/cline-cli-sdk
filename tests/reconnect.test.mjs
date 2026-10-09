import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
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
const executionId = "run-11111111-1111-4111-8111-111111111111";
const identity = { pid: 42, startTime: "100", bootId: "boot-1" };
function boundary(t, replies) {
  t.mock.method(childProcess, "spawn", () => {
    const p = new EventEmitter();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin = new PassThrough();
    p.kill = () => {};
    let body = "";
    p.stdin.on("data", (c) => (body += c));
    p.stdin.on("finish", () => {
      const next = replies.shift();
      const result = typeof next === "function" ? next(JSON.parse(body)) : next;
      p.stdout.end(JSON.stringify(result));
      queueMicrotask(() => p.emit("close", 0));
    });
    return p;
  });
}
const fresh = () =>
  createClient({
    mode: "live",
    connection: { host: "fixture", remoteRoot: "/fixture/control" },
  });
test("a restarted consumer lists SDK executions and restores the existing pending question without launching a new run", async (t) => {
  const source = JSON.parse(
    await readFile(
      new URL("../fixtures/interactions/choice.json", import.meta.url),
    ),
  );
  const history = source.observations
    .filter((x) => x.kind === "history")
    .find((x) =>
      JSON.parse(Buffer.from(x.dataBase64, "base64")).messages.some((m) =>
        m.content.some((c) => c.type === "tool_use"),
      ),
    );
  const doc = JSON.parse(Buffer.from(history.dataBase64, "base64"));
  doc.sessionId = "fixture-session";
  const listing = {
    executions: [
      {
        executionId,
        remoteRoot: "/fixture/control",
        sessionId: "fixture-session",
        alive: true,
        identityConfirmed: true,
        terminal: { rows: 40, cols: 120 },
      },
    ],
  };
  boundary(t, [
    pinned,
    listing,
    listing,
    (r) => ({
      executionId: r.executionId,
      sessionId: "fixture-session",
      cursor: 40,
      gap: true,
      management: { phaseSupported: true },
      observations: [],
      screen: {
        dataBase64: Buffer.from(
          "\x1b[2J\x1b[H[follow-up] Choose test color.\r\n  1. RED\r\n  2. BLUE\r\nChoose 1-2 or type a custom answer:\r\n> ",
        ).toString("base64"),
      },
      history: {
        dataBase64: Buffer.from(JSON.stringify(doc)).toString("base64"),
        sha256: "history-1",
      },
      process: {
        kind: "process",
        identity,
        alive: true,
        identityConfirmed: true,
        exitCode: null,
        manifestStatus: "pending",
      },
    }),
    (r) => ({
      phase: {
        fingerprint: r.fingerprint,
        epoch: 1,
        id: r.interactionId,
        active: true,
      },
    }),
  ]);
  const client = fresh();
  await client.connect();
  const runs = await client.listManagedExecutions();
  assert.equal(runs[0].executionId, executionId);
  const s = await client.attach(executionId);
  assert.equal(s.executionId, executionId);
  assert.equal(s.sessionId, "fixture-session");
  assert.equal(s.execution, "awaiting-input");
  assert.deepEqual(s.interaction.choices, ["RED", "BLUE"]);
  client.disconnect();
  assert.equal(client.snapshot().connection, "disconnected");
  assert.equal(client.snapshot().executionId, executionId);
  assert.equal(client.snapshot().interaction.id, s.interaction.id);
  client.close();
});
test("disconnect wins an in-flight poll and a late result cannot reconnect the consumer", async (t) => {
  let client;
  boundary(t, [
    pinned,
    (r) => ({
      executionId: r.executionId,
      remoteRoot: "/fixture/control",
      sessionId: null,
    }),
    (r) => ({
      executionId: r.executionId,
      cursor: 0,
      observations: [],
      process: {
        kind: "process",
        identity,
        alive: true,
        identityConfirmed: true,
        exitCode: null,
        manifestStatus: "pending",
      },
    }),
  ]);
  client = fresh();
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "hello" });
  const pending = client.refresh();
  client.disconnect();
  await assert.rejects(pending, { code: "connection-interrupted" });
  assert.equal(client.snapshot().connection, "disconnected");
  client.close();
});
test("durable remote phase evidence retains question identity across clients and gives a later identical phase a new identity", async (t) => {
  const source = JSON.parse(
    await readFile(
      new URL("../fixtures/interactions/choice.json", import.meta.url),
    ),
  );
  const raw = source.observations.find(
    (x) =>
      x.kind === "history" &&
      JSON.parse(Buffer.from(x.dataBase64, "base64")).messages.some((m) =>
        m.content.some((c) => c.type === "tool_use"),
      ),
  );
  const doc = JSON.parse(Buffer.from(raw.dataBase64, "base64"));
  doc.sessionId = "fixture-session";
  const listing = {
    executions: [
      {
        executionId,
        remoteRoot: "/fixture/control",
        sessionId: doc.sessionId,
        terminal: { rows: 40, cols: 120 },
      },
    ],
  };
  let phase = { epoch: 0, active: false };
  const status = () => ({
    executionId,
    sessionId: doc.sessionId,
    cursor: 40,
    management: { phaseSupported: true },
    phase,
    observations: [],
    screen: {
      dataBase64: Buffer.from(
        "\x1b[2J\x1b[H[follow-up] Choose test color.\r\n  1. RED\r\n  2. BLUE\r\nChoose 1-2 or type a custom answer:\r\n> ",
      ).toString("base64"),
    },
    history: {
      sha256: "history-1",
      dataBase64: Buffer.from(JSON.stringify(doc)).toString("base64"),
    },
    process: {
      kind: "process",
      identity,
      alive: true,
      identityConfirmed: true,
      exitCode: null,
      manifestStatus: "pending",
    },
  });
  const bind = (r) => ({
    phase: (phase = {
      epoch: phase.epoch + 1,
      active: true,
      fingerprint: r.fingerprint,
      id: r.interactionId,
    }),
  });
  boundary(t, [
    pinned,
    listing,
    status,
    bind,
    pinned,
    listing,
    status,
    pinned,
    listing,
    status,
    bind,
  ]);
  const first = fresh();
  await first.connect();
  const before = await first.attach(executionId);
  first.close();
  const second = fresh();
  await second.connect();
  const restored = await second.attach(executionId);
  assert.equal(restored.interaction.id, before.interaction.id);
  second.close();
  // Fault-injected later phase closure: no recorded CLI observation is claimed here.
  phase = { ...phase, active: false };
  const third = fresh();
  await third.connect();
  const later = await third.attach(executionId);
  assert.notEqual(later.interaction.id, before.interaction.id);
  third.close();
});
test("fault-injected machine boot change keeps the recovered history but never marks a stale PID or prompt as running", async (t) => {
  const source = JSON.parse(
    await readFile(
      new URL("../fixtures/live-completion.json", import.meta.url),
    ),
  );
  const raw = source.observations.find((x) => x.kind === "history");
  const doc = JSON.parse(Buffer.from(raw.dataBase64, "base64"));
  boundary(t, [
    pinned,
    {
      executions: [
        {
          executionId,
          remoteRoot: "/fixture/control",
          sessionId: doc.sessionId,
          alive: false,
          identityConfirmed: false,
          terminal: { rows: 40, cols: 120 },
        },
      ],
    },
    () => ({
      executionId,
      sessionId: doc.sessionId,
      cursor: 4,
      observations: [],
      history: { sha256: "good-history", dataBase64: raw.dataBase64 },
      process: {
        kind: "process",
        identity: { ...identity, bootId: "previous-boot" },
        alive: false,
        identityConfirmed: false,
        exitCode: 0,
        manifestStatus: "completed",
      },
    }),
  ]);
  const client = fresh();
  await client.connect();
  const s = await client.attach(executionId);
  assert.equal(s.execution, "unknown");
  assert.equal(s.interaction, null);
  assert.ok(s.messages.some((m) => m.text === "SDK_LIVE_READY"));
  client.close();
});
