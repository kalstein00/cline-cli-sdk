import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@cline-cli-sdk/sdk";
const fixture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`../fixtures/text/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
test("public replay anchors the current TUI question and exposes exact custom echo without changing its identity", async () => {
  const recording = await fixture("tui-custom-response");
  const client = createClient({ mode: "replay" });
  await client.openReplay(recording);
  while (
    client.snapshot().replay.position <
    recording.observations.findIndex((o) => o.seq > 98)
  )
    await client.nextObservation();
  const initial = client.snapshot().interaction;
  assert.equal(initial.kind, "question");
  assert.deepEqual(initial.choices, ["RED", "BLUE"]);
  assert.ok(initial.responseKinds.includes("text"));
  while (
    client.snapshot().replay.position <
    recording.observations.findIndex((o) => o.seq > 1417)
  )
    await client.nextObservation();
  assert.equal(client.snapshot().interaction.id, initial.id);
  assert.equal(client.snapshot().interaction.input.selected, 2);
  assert.equal(client.snapshot().interaction.input.text, "2 custom identifier");
  await client.replayAll();
  assert.equal(
    client.snapshot().messages.at(-1).text,
    "TUI_IDENTIFIER:2 custom identifier",
  );
  client.close();
});
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
const pinned = {
  platform: "Linux",
  python: true,
  pty: true,
  tmux: "tmux 3.4",
  cliPath: "/fixture/cline",
  cliVersion: "3.0.69",
  cliHash: "8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032",
  bootId: "boot",
};
function boundary(t, handler) {
  t.mock.method(childProcess, "spawn", () => {
    const p = new EventEmitter();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin = new PassThrough();
    p.kill = () => {};
    let input = "";
    p.stdin.on("data", (d) => (input += d));
    p.stdin.on("finish", () => {
      p.stdout.end(JSON.stringify(handler(JSON.parse(input))));
      queueMicrotask(() => p.emit("close", 0, null));
    });
    return p;
  });
}
test("consumer numeric custom waits for selected custom row and exact echo then separate submit and same-tool result", async (t) => {
  const record = await fixture("tui-custom-response");
  let position = 98,
    writes = [];
  boundary(t, (r) => {
    if (!r.action) return pinned;
    if (r.action === "start")
      return { executionId: r.executionId, remoteRoot: "/fixture/control" };
    if (r.action === "respond") {
      writes.push(r);
      position =
        r.inputType === "tui-navigation"
          ? 460
          : r.inputType === "tui-text"
            ? 1417
            : 1487;
      return { state: "queued" };
    }
    if (r.action === "status")
      return {
        executionId: r.executionId,
        sessionId: record.sessionId,
        cursor: position,
        modalHash: "fixture-modal",
        observations: record.observations.filter(
          (o) => o.seq > r.cursor && o.seq <= position,
        ),
        process: {
          identity: { pid: 42, startTime: "100", bootId: "boot" },
          alive: true,
          identityConfirmed: true,
          exitCode: null,
          manifestStatus: "pending",
        },
        requests: writes.map((w) => ({
          requestId: w.requestId,
          state: "written",
          steps: [{ index: w.stepIndex, state: "written" }],
        })),
      };
    throw new Error("unexpected");
  });
  const client = createClient({
    mode: "live",
    connection: { host: "fixture" },
  });
  await client.connect();
  await client.start({
    cwd: "/fixture/work",
    prompt: "controlled",
    terminalMode: "tui",
  });
  await client.refresh();
  const s = client.snapshot();
  const request = {
    sessionId: s.sessionId,
    executionId: s.executionId,
    interactionId: s.interaction.id,
    revision: s.revision,
    requestId: "numeric-custom",
    answer: "2 custom identifier",
  };
  const [a, b] = await Promise.all([
    client.respond(request),
    client.respond(request),
  ]);
  assert.equal(a.state, "delivered");
  assert.deepEqual(a, b);
  assert.equal(
    client.snapshot().messages.at(-1).text,
    "TUI_IDENTIFIER:2 custom identifier",
  );
  assert.deepEqual(
    writes.map((w) => Buffer.from(w.dataBase64, "base64").toString()),
    ["\x1b[A", "2 custom identifier", "\r"],
  );
  client.close();
});
test("consumer safe readline custom preserves exact text and numeric collision is rejected before write", async (t) => {
  const record = await fixture("readline-free-text");
  let position = 19,
    writes = [];
  boundary(t, (r) => {
    if (!r.action) return pinned;
    if (r.action === "start")
      return { executionId: r.executionId, remoteRoot: "/fixture/control" };
    if (r.action === "respond") {
      writes.push(r);
      position = 32;
      return { state: "queued" };
    }
    if (r.action === "status")
      return {
        executionId: r.executionId,
        sessionId: record.sessionId,
        cursor: position,
        observations: record.observations.filter(
          (o) => o.seq > r.cursor && o.seq <= position,
        ),
        process: {
          identity: { pid: 42, startTime: "100", bootId: "boot" },
          alive: true,
          identityConfirmed: true,
          exitCode: null,
          manifestStatus: "pending",
        },
      };
    throw new Error("unexpected");
  });
  const client = createClient({
    mode: "live",
    connection: { host: "fixture" },
  });
  await client.connect();
  await client.start({
    cwd: "/fixture/work",
    prompt: "controlled",
    terminalMode: "readline",
  });
  await client.refresh();
  const s = client.snapshot();
  const request = {
    sessionId: s.sessionId,
    executionId: s.executionId,
    interactionId: s.interaction.id,
    revision: s.revision,
    requestId: "readline-text",
    answer: "CUSTOM-42",
  };
  await assert.rejects(
    client.respond({
      ...request,
      requestId: "numeric",
      answer: "2 custom identifier",
    }),
    { code: "unsupported-answer" },
  );
  assert.equal((await client.respond(request)).state, "delivered");
  assert.equal(client.snapshot().messages.at(-1).text, "LABEL:CUSTOM-42");
  assert.equal(
    Buffer.from(writes[0].dataBase64, "base64").toString(),
    "CUSTOM-42\r",
  );
  client.close();
});
test("current TUI approval binds exact command history and a different popup blocks the destination", async () => {
  const r = JSON.parse(
    await readFile(
      new URL("../fixtures/interactions/approve.json", import.meta.url),
      "utf8",
    ),
  );
  r.cli.profile = "cline-3.0.69-tui";
  r.provenance.source = "fault-injection";
  r.provenance.transformations.push(
    "Source-grounded TUI approval screen injected; real readline tool history retained.",
  );
  r.observations = [
    r.observations.find(
      (o) =>
        o.kind === "history" &&
        Buffer.from(o.dataBase64, "base64").toString().includes("tool_use"),
    ),
  ];
  r.observations.push({
    kind: "pty",
    seq: r.observations[0].seq + 1,
    observedAt: r.observations[0].observedAt,
    dataBase64: Buffer.from(
      "\x1b[2J\x1b[27;1H Cline needs permission\r\n\r\n Approve tool call?\r\n\r\n run_commands\r\n\r\n   $ printf APPROVAL_PROBE\r\n\r\n  [y] Approve   [n] Deny",
    ).toString("base64"),
  });
  const c = createClient({ mode: "replay" });
  await c.openReplay(r);
  await c.replayAll();
  assert.equal(c.snapshot().interaction.kind, "approval");
  assert.equal(c.snapshot().interaction.toolName, "run_commands");
  r.observations.push({
    kind: "pty",
    seq: r.observations.at(-1).seq + 1,
    observedAt: r.observations[0].observedAt,
    dataBase64: Buffer.from(
      "\x1b[20;1H Press Enter to open, any other key to close",
    ).toString("base64"),
  });
  await c.openReplay(r);
  await c.replayAll();
  assert.equal(c.snapshot().interaction.state, "unsupported");
  c.close();
});
test("actual Korean emoji modal echo preserves spacing with Unicode cell widths and split UTF8", async () => {
  const r = await fixture("tui-korean-echo");
  const c = createClient({ mode: "replay" });
  await c.openReplay(r);
  await c.replayAll();
  assert.equal(c.snapshot().interaction.input.text, "한글 응답 가나다 😀 café");
  const split = structuredClone(r);
  split.provenance.source = "fault-injection";
  split.provenance.transformations.push(
    "PTY bytewise UTF8 packet segmentation",
  );
  let seq = 0;
  split.observations = split.observations.flatMap((o) =>
    o.kind === "pty"
      ? (() => {
          const b = Buffer.from(o.dataBase64, "base64");
          const cuts = [0, b.length];
          for (const glyph of ["한", "😀"]) {
            const at = b.indexOf(Buffer.from(glyph));
            if (at >= 0)
              for (let n = 1; n < Buffer.byteLength(glyph); n++)
                cuts.push(at + n);
          }
          cuts.sort((a, b) => a - b);
          return cuts.slice(0, -1).map((at, n) => ({
            ...o,
            seq: ++seq,
            dataBase64: b.subarray(at, cuts[n + 1]).toString("base64"),
          }));
        })()
      : [{ ...o, seq: ++seq }],
  );
  await c.openReplay(split);
  await c.replayAll();
  assert.equal(c.snapshot().interaction.input.text, "한글 응답 가나다 😀 café");
  c.close();
});
test("a written TUI custom step without exact echo remains unknown and never sends Enter or repeats input", async (t) => {
  const record = await fixture("tui-custom-response");
  let position = 98,
    writes = [];
  boundary(t, (r) => {
    if (!r.action) return pinned;
    if (r.action === "start")
      return { executionId: r.executionId, remoteRoot: "/fixture/control" };
    if (r.action === "respond") {
      writes.push(r);
      position = 460;
      return { state: "queued" };
    }
    if (r.action === "status")
      return {
        executionId: r.executionId,
        sessionId: record.sessionId,
        cursor: position,
        modalHash: "fixture-modal",
        observations: record.observations.filter(
          (o) => o.seq > r.cursor && o.seq <= position,
        ),
        process: {
          identity: { pid: 42, startTime: "100", bootId: "boot" },
          alive: true,
          identityConfirmed: true,
          exitCode: null,
          manifestStatus: "pending",
        },
        requests: writes.map((w) => ({
          requestId: w.requestId,
          state: "written",
          steps: [{ index: w.stepIndex, state: "written" }],
        })),
      };
    throw new Error("unexpected");
  });
  const c = createClient({
    mode: "live",
    connection: { host: "fixture", responseTimeoutMs: 250 },
  });
  await c.connect();
  await c.start({
    cwd: "/fixture/work",
    prompt: "controlled",
    terminalMode: "tui",
  });
  await c.refresh();
  const s = c.snapshot();
  const r = {
    sessionId: s.sessionId,
    executionId: s.executionId,
    interactionId: s.interaction.id,
    revision: s.revision,
    requestId: "missing-echo",
    answer: "2 custom identifier",
  };
  await assert.rejects(c.respond(r), { code: "input-uncertain" });
  assert.equal(c.snapshot().response.state, "delivery-unknown");
  await assert.rejects(c.respond(r), { code: "input-uncertain" });
  assert.deepEqual(
    writes.map((w) => w.inputType),
    ["tui-navigation", "tui-text"],
  );
  c.close();
});
test("actual TUI wrapped custom rows preserve the first character of continuation", async () => {
  const r = await fixture("tui-wrapped-echo");
  const c = createClient({ mode: "replay" });
  await c.openReplay(r);
  await c.replayAll();
  assert.equal(
    c.snapshot().interaction.input.text,
    "LONG_" +
      "abcdefghijklmnopqrstuvwxyz0123456789".repeat(3) +
      "abcdefghijklmno",
  );
  c.close();
});
test("TUI history text resembling a choice cannot replace the displayed question header", async () => {
  const r = await fixture("tui-custom-response");
  r.observations = r.observations.filter((o) => o.seq <= 98);
  const h = r.observations.find((o) => o.kind === "history");
  const d = JSON.parse(Buffer.from(h.dataBase64, "base64"));
  for (const m of d.messages)
    for (const p of m.content)
      if (p.type === "tool_use" && p.name === "ask_question")
        p.input.question = "BLUE";
  h.dataBase64 = Buffer.from(JSON.stringify(d)).toString("base64");
  r.provenance.source = "fault-injection";
  const c = createClient({ mode: "replay" });
  await c.openReplay(r);
  await c.replayAll();
  assert.equal(c.snapshot().interaction.state, "unsupported");
  c.close();
});
