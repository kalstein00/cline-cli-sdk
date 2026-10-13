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
    matches: false,
    prefixMatches: true,
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
  const comparison = compareDiagnostic(bundle, events, replay.snapshot());
  assert.equal(comparison.matches, false);
  assert.equal(comparison.prefixMatches, true);
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
