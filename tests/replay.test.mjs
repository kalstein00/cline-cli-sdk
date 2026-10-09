import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@cline-cli-sdk/sdk";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const fixture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`../fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
test("Node consumer sees the recorded assistant message through the public SDK", async () => {
  const client = createClient({ mode: "replay" });
  const events = [];
  client.subscribe((event) => events.push(event));
  await client.openReplay(await fixture("message"));
  await client.replayAll();
  assert.deepEqual(
    client.snapshot().messages.map((m) => [m.role, m.text]),
    [["assistant", "CHOSEN:BLUE"]],
  );
  assert.equal(events.filter((e) => e.type === "message.upsert").length, 1);
  assert.equal(client.snapshot().connection, "replay");
  client.close();
});
test("history message updates retain identity and malformed reads preserve the last good snapshot", async () => {
  const client = createClient({ mode: "replay" });
  const recording = await fixture("message");
  recording.observations.push({
    kind: "history",
    seq: 31,
    observedAt: "2026-10-09T09:19:01Z",
    dataBase64: Buffer.from('{"messages":[').toString("base64"),
  });
  recording.observations.push({
    kind: "history",
    seq: 32,
    observedAt: "2026-10-09T09:19:02Z",
    dataBase64: Buffer.from(
      JSON.stringify({
        version: 1,
        sessionId: "fixture-session",
        messages: [
          {
            id: "fixture-message",
            role: "assistant",
            content: [{ type: "text", text: "CHOSEN:BLUE (updated)" }],
          },
        ],
      }),
    ).toString("base64"),
  });
  await client.openReplay(recording);
  await client.nextObservation();
  await assert.rejects(client.nextObservation(), { code: "invalid-history" });
  assert.equal(client.snapshot().messages[0].text, "CHOSEN:BLUE");
  await client.nextObservation();
  assert.deepEqual(
    client.snapshot().messages.map((m) => [m.id, m.text]),
    [["fixture-message", "CHOSEN:BLUE (updated)"]],
  );
  assert.equal(client.snapshot().revision, 4);
  client.close();
});
test("split UTF-8 and cursor erasure restore the intended Korean question", async () => {
  const client = createClient({ mode: "replay" });
  const recording = await fixture("question");
  const bytes = Buffer.from(
    "\x1b[2J\x1b[H[follow-up] 어떤 색상?\r\n  1. WRONG\r\x1b[2K  1. 빨강\r\n  2. 파랑\r\nChoose 1-2 or type a custom answer:\r\n> ",
  );
  recording.provenance.transformations.push(
    "fault-injection: Korean replacement, cursor erasure, every-byte fragmentation",
  );
  recording.observations = [...bytes].map((byte, index) => ({
    kind: "pty",
    seq: index + 1,
    observedAt: "2026-10-09T09:19:00Z",
    dataBase64: Buffer.from([byte]).toString("base64"),
  }));
  await client.openReplay(recording);
  await client.replayAll();
  assert.equal(client.snapshot().interaction.prompt, "어떤 색상?");
  assert.deepEqual(client.snapshot().interaction.choices, ["빨강", "파랑"]);
  client.close();
});
test("public replay makes no network, model, child command, or remote-input side effects", async (t) => {
  const blocked = () => {
    throw new Error("Replay attempted an external side effect");
  };
  const boundaries = [
    "spawn",
    "exec",
    "execFile",
    "spawnSync",
    "execSync",
    "execFileSync",
  ].map((name) => t.mock.method(childProcess, name, blocked));
  const fetch = t.mock.method(globalThis, "fetch", blocked);
  syncBuiltinESMExports();
  try {
    const client = createClient({ mode: "replay" });
    await client.openReplay(await fixture("question"));
    await client.replayAll();
    await assert.rejects(
      client.respond({
        sessionId: "fixture-session",
        executionId: "fixture-execution",
        interactionId: client.snapshot().interaction.id,
        revision: client.snapshot().revision,
        requestId: "no-write",
        answer: "2 custom 한글",
      }),
      { code: "replay-read-only" },
    );
    assert.equal(
      boundaries.reduce(
        (sum, mock) => sum + mock.mock.callCount(),
        fetch.mock.callCount(),
      ),
      0,
    );
    assert.equal(client.snapshot().interaction.prompt, "Choose test color.");
    client.close();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
test("old question in scrollback closes and a later identical question gets a new identity", async () => {
  const client = createClient({ mode: "replay" });
  const recording = await fixture("question");
  const question = recording.observations
    .map((o) => Buffer.from(o.dataBase64, "base64"))
    .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
  recording.observations.push({
    kind: "pty",
    seq: 20,
    observedAt: "2026-10-09T09:19:01Z",
    dataBase64: Buffer.from("2\r\nCHOSEN:BLUE\r\n").toString("base64"),
  });
  recording.observations.push({
    kind: "pty",
    seq: 21,
    observedAt: "2026-10-09T09:19:02Z",
    dataBase64: question.toString("base64"),
  });
  await client.openReplay(recording);
  await client.nextObservation();
  await client.nextObservation();
  const firstId = client.snapshot().interaction.id;
  await client.nextObservation();
  assert.equal(client.snapshot().interaction, null);
  assert.equal(client.snapshot().execution, "unknown");
  await client.nextObservation();
  assert.equal(client.snapshot().interaction.prompt, "Choose test color.");
  assert.notEqual(client.snapshot().interaction.id, firstId);
  client.close();
});
test("invalid recording order is rejected before changing the current conversation", async () => {
  const client = createClient({ mode: "replay" });
  await client.openReplay(await fixture("message"));
  await client.replayAll();
  const invalid = await fixture("question");
  invalid.observations[1].seq = invalid.observations[0].seq;
  await assert.rejects(client.openReplay(invalid), {
    code: "invalid-recording",
  });
  assert.equal(client.snapshot().messages[0].text, "CHOSEN:BLUE");
  client.close();
});
test("unknown question syntax remains unsupported rather than silently actionable", async () => {
  const client = createClient({ mode: "replay" });
  const recording = await fixture("question");
  recording.observations = [
    {
      kind: "pty",
      seq: 1,
      observedAt: "2026-10-09T00:00:00Z",
      dataBase64: Buffer.from("Choose a mystery route? [a/b]\r\n> ").toString(
        "base64",
      ),
    },
  ];
  await client.openReplay(recording);
  await client.replayAll();
  assert.equal(client.snapshot().interaction.state, "unsupported");
  assert.equal(client.snapshot().execution, "unknown");
  client.close();
});
test("unimplemented approval screens and unknown CLI profiles block all remote input", async () => {
  const client = createClient({ mode: "replay" });
  await client.openReplay(await fixture("unsupported"));
  await client.replayAll();
  assert.equal(client.snapshot().interaction.state, "unsupported");
  assert.equal(client.snapshot().execution, "unknown");
  const unknown = await fixture("question");
  unknown.cli.profile = "company-fork-unknown";
  await client.openReplay(unknown);
  await client.replayAll();
  assert.equal(client.snapshot().interaction.state, "unsupported");
  await assert.rejects(
    client.respond({
      sessionId: "fixture-session",
      executionId: "fixture-execution",
      interactionId: client.snapshot().interaction.id,
      revision: client.snapshot().revision,
      requestId: "r1",
      answer: "RED",
    }),
    { code: "replay-read-only" },
  );
  assert.deepEqual(client.capabilities(), {
    structuredResults: { json: true, schemaValidation: true, nativeSchema: false },
    replay: true,
    live: false,
    responses: false,
    companyCompatibility: "unverified",
  });
  client.close();
});
test("consumer receives one color question from real ANSI terminal observations", async () => {
  const client = createClient({ mode: "replay" });
  const events = [];
  client.subscribe((e) => events.push(e));
  const recording = await fixture("question");
  recording.observations.push({ ...recording.observations[1], seq: 19 });
  await client.openReplay(recording);
  await client.replayAll();
  assert.equal(client.snapshot().interaction.prompt, "Choose test color.");
  assert.deepEqual(client.snapshot().interaction.choices, ["RED", "BLUE"]);
  assert.equal(client.snapshot().execution, "awaiting-input");
  assert.equal(
    events.filter((e) => e.type === "interaction.changed").length,
    1,
  );
  client.close();
});
