import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClient,
  readDiagnostic,
  compareDiagnostic,
} from "@cline-cli-sdk/sdk";
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

test("raw question response receipts produce the same events offline and sidecar changes cannot drive interpretation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cline-sdk-diag-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = JSON.parse(
    await readFile(
      new URL("../fixtures/interactions/choice.json", import.meta.url),
      "utf8",
    ),
  );
  let position = 18;
  let submitted;
  let historyMode = "normal";
  let transportForbidden = false;
  t.mock.method(childProcess, "spawn", () => {
    if (transportForbidden) throw Error("offline transport forbidden");
    const p = new EventEmitter();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin = new PassThrough();
    p.kill = () => {};
    let input = "";
    p.stdin.on("data", (d) => (input += d));
    p.stdin.on("finish", () => {
      const r = JSON.parse(input);
      let value;
      if (!r.action)
        value = {
          platform: "Linux",
          python: true,
          pty: true,
          tmux: "tmux 3.4",
          cliPath: "/fixture/cline",
          cliVersion: "3.0.69",
          cliHash:
            "8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032",
          bootId: "boot",
        };
      if (r.action === "start")
        value = { executionId: r.executionId, remoteRoot: "/fixture/control" };
      if (r.action === "respond") {
        submitted = r;
        position = 30;
        value = { state: "queued" };
      }
      if (r.action === "status")
        value = {
          executionId: r.executionId,
          sessionId: record.sessionId,
          cursor: position,
          observations: record.observations.filter(
            (o) => o.seq > r.cursor && o.seq <= position,
          ),
          process: {
            kind: "process",
            identity: { pid: 42, startTime: "100", bootId: "boot" },
            alive: true,
            identityConfirmed: true,
            exitCode: null,
            manifestStatus: "pending",
          },
          requests: submitted
            ? [
                {
                  requestId: submitted.requestId,
                  state: "written",
                  binding: submitted,
                },
              ]
            : [],
          ...(historyMode === "missing"
            ? { history: null, historyError: "read-failed" }
            : historyMode !== "normal"
              ? {
                  history: {
                    sha256: historyMode,
                    dataBase64:
                      historyMode === "partial"
                        ? Buffer.from('{"messages":[').toString("base64")
                        : record.observations
                            .filter((o) => o.kind === "history" && o.seq <= 18)
                            .at(-1).dataBase64,
                  },
                }
              : {}),
        };
      p.stdout.end(JSON.stringify(value));
      queueMicrotask(() => p.emit("close", 0, null));
    });
    return p;
  });
  const live = createClient({ mode: "live", connection: { host: "fixture" } });
  await live.startDiagnostics({ directory });
  await live.connect();
  await live.start({ cwd: "/fixture/work", prompt: "controlled" });
  await live.refresh();
  const s = live.snapshot();
  historyMode = "missing";
  await live.refresh();
  assert.equal(live.snapshot().historySync.current, false);
  assert.equal(live.snapshot().interaction.id, s.interaction.id);
  historyMode = "partial";
  await live.refresh();
  assert.equal(live.snapshot().historySync.current, false);
  historyMode = "good";
  await live.refresh();
  assert.equal(live.snapshot().historySync.current, true);
  assert.equal(live.snapshot().interaction.id, s.interaction.id);
  historyMode = "normal";
  const result = await live.respond({
    sessionId: s.sessionId,
    executionId: s.executionId,
    interactionId: s.interaction.id,
    revision: live.snapshot().revision,
    requestId: "diagnostic-choice",
    answer: "BLUE",
  });
  assert.equal(result.state, "delivered");
  const status = await live.stopDiagnostics();
  const bundle = await readDiagnostic(status.path);
  assert.ok(
    bundle.recording.observations.some((o) => o.kind === "response-input"),
  );
  assert.ok(
    bundle.recording.observations.some((o) => o.kind === "history-failure"),
  );
  transportForbidden = true;
  const replay = createClient({ mode: "replay" });
  const events = [];
  replay.subscribe((e) => events.push(e));
  await replay.openReplay(bundle.recording);
  await replay.replayAll();
  assert.equal(replay.snapshot().response.state, "delivered");
  assert.equal(replay.snapshot().messages.at(-1).text, "CHOSEN:BLUE");
  assert.equal(
    compareDiagnostic(bundle, events, replay.snapshot()).matches,
    true,
  );
  bundle.comparison.snapshot.response.state = "delivery-unknown";
  assert.equal(
    compareDiagnostic(bundle, events, replay.snapshot()).matches,
    false,
  );
  assert.equal(replay.snapshot().response.state, "delivered");
  live.close();
  replay.close();
});

test("finite bundle retention protects an active collector and removes only finalized owned bundles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cline-sdk-diag-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    mode: "live",
    connection: {
      host: "fixture",
      sshExecutable: "cline-sdk-missing-ssh-diagnostics",
    },
  };
  const first = createClient(options),
    second = createClient(options);
  t.after(() => {
    first.close();
    second.close();
  });
  const active = await first.startDiagnostics({ directory, maxBundles: 1 });
  const blocked = await second.startDiagnostics({ directory, maxBundles: 1 });
  assert.equal(blocked.state, "failed");
  assert.equal(blocked.failure, "diagnostic-bundle-limit");
  assert.equal((await stat(active.path)).isDirectory(), true);
  await first.stopDiagnostics();
  const next = await second.startDiagnostics({ directory, maxBundles: 1 });
  assert.equal(next.state, "collecting");
  await assert.rejects(stat(active.path), { code: "ENOENT" });
  await writeFile(join(next.path, "user-note.txt"), "preserve user data");
  await second.stopDiagnostics();
  await first.startDiagnostics({ directory, maxBundles: 1 });
  assert.equal(
    await readFile(join(next.path, "user-note.txt"), "utf8"),
    "preserve user data",
  );
  await first.stopDiagnostics();
});

test("consumer captures a real SSH startup failure and reinterprets it offline without transport", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cline-sdk-diag-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = createClient({
    mode: "live",
    connection: {
      host: "fixture",
      sshExecutable: "cline-sdk-missing-ssh-diagnostics",
      identityFile: "DO_NOT_COLLECT_PRIVATE_KEY",
    },
  });
  const events = [];
  live.subscribe((e) => events.push(e));
  const active = await live.startDiagnostics({ directory });
  assert.equal(active.state, "collecting");
  assert.ok(active.path.startsWith(directory));
  await assert.rejects(live.connect(), { code: "ssh-unavailable" });
  const expected = live.snapshot();
  const stopped = await live.stopDiagnostics();
  assert.equal(stopped.state, "stopped");
  const bundle = await readDiagnostic(stopped.path);
  assert.equal(
    JSON.stringify(bundle).includes("DO_NOT_COLLECT_PRIVATE_KEY"),
    false,
  );
  assert.ok(
    bundle.recording.observations.some(
      (o) => o.kind === "connection" && o.reason === "ssh-unavailable",
    ),
  );
  const replay = createClient({ mode: "replay" });
  const observed = [];
  replay.subscribe((e) => observed.push(e));
  await replay.openReplay(bundle.recording);
  await replay.replayAll();
  assert.equal(replay.snapshot().connection, "disconnected");
  assert.deepEqual(compareDiagnostic(bundle, observed, replay.snapshot()), {
    matches: true,
    eventDifferences: 0,
    snapshotMatches: true,
  });
  assert.deepEqual(observed, events);
  assert.equal(replay.snapshot().execution, expected.execution);
  live.close();
  replay.close();
});
test("finite diagnostics stop at the byte limit and storage failure leaves client control usable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cline-sdk-diag-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = createClient({
    mode: "live",
    connection: {
      host: "fixture",
      sshExecutable: "cline-sdk-missing-ssh-diagnostics",
    },
  });
  await live.startDiagnostics({
    directory,
    maxBytes: 4096,
    maxBundles: 2,
    retentionDays: 1,
  });
  for (let n = 0; n < 12 && live.diagnostics().state === "collecting"; n++)
    await assert.rejects(live.connect(), { code: "ssh-unavailable" });
  assert.equal(live.diagnostics().state, "limit-reached");
  assert.equal(live.diagnostics().truncated, true);
  assert.ok(live.diagnostics().bytes <= 4096);
  const limited = await live.stopDiagnostics();
  assert.equal(
    limited.bytes,
    (await stat(join(limited.path, "manifest.json"))).size +
      (await stat(join(limited.path, "observations.ndjson"))).size,
  );
  assert.ok(limited.bytes <= 4096);
  const bundle = await readDiagnostic(limited.path);
  assert.equal(bundle.recording.provenance.truncated, true);
  const replay = createClient({ mode: "replay" });
  const events = [];
  replay.subscribe((e) => events.push(e));
  await replay.openReplay(bundle.recording);
  await replay.replayAll();
  assert.equal(
    compareDiagnostic(bundle, events, replay.snapshot()).matches,
    true,
  );
  const blocked = join(directory, "occupied");
  await writeFile(blocked, "user file");
  const failure = await live.startDiagnostics({ directory: blocked });
  assert.equal(failure.state, "failed");
  assert.ok(failure.failure);
  assert.equal(live.snapshot().connection, "disconnected");
  await assert.rejects(live.connect(), { code: "ssh-unavailable" });
  assert.equal(await readFile(blocked, "utf8"), "user file");
  await live.stopDiagnostics();
  live.close();
  replay.close();
});
