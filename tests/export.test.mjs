import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClient,
  reviewDiagnostic,
  inspectDiagnostic,
  previewDiagnosticExport,
  exportDiagnostic,
  readDiagnostic,
  compareDiagnostic,
} from "@cline-cli-sdk/sdk";
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

async function capture(t, directory, extras = []) {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/interactions/choice.json", import.meta.url),
      "utf8",
    ),
  );
  // Only the external SSH boundary is replaced with reviewed raw CLI observations.
  t.mock.method(childProcess, "spawn", () => {
    const p = new EventEmitter();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin = new PassThrough();
    p.kill = () => {};
    let input = "";
    p.stdin.on("data", (d) => (input += d));
    p.stdin.on("finish", () => {
      const r = JSON.parse(input);
      let result;
      if (!r.action)
        result = {
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
        result = { executionId: r.executionId, remoteRoot: "/fixture/control" };
      if (r.action === "status")
        result = {
          executionId: r.executionId,
          sessionId: fixture.sessionId,
          cursor: 18 + extras.length,
          observations: [
            ...fixture.observations.filter((o) => o.seq <= 18),
            ...extras,
          ].filter((o) => o.seq > r.cursor),
          process: {
            kind: "process",
            identity: { pid: 42, startTime: "100", bootId: "boot" },
            alive: true,
            identityConfirmed: true,
            exitCode: null,
            manifestStatus: "pending",
          },
          requests: [],
        };
      p.stdout.end(JSON.stringify(result));
      queueMicrotask(() => p.emit("close", 0, null));
    });
    return p;
  });
  const c = createClient({
    mode: "live",
    connection: {
      host: "fixture",
      identityFile: "EXCLUDED_PRIVATE_KEY_SOURCE",
    },
  });
  await c.startDiagnostics({ directory });
  await c.connect();
  await c.start({ cwd: "/fixture/work", prompt: "controlled" });
  await c.refresh();
  const saved = await c.stopDiagnostics();
  c.close();
  return saved.path;
}

test("consumer reviews every included raw and comparison item through finite decoded content pages before export", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cline-sdk-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = await capture(t, dir);
  const review = await reviewDiagnostic(path);
  assert.equal(review.integrity.state, "verified");
  assert.equal(review.replay.state, "ready");
  assert.ok(review.included.some((i) => i.kind === "history"));
  assert.ok(review.included.some((i) => i.kind === "pty"));
  assert.equal(review.credentials.excludedSources, true);
  let contents = "";
  for (let index = 0; index < review.items; index++) {
    let offset = 0;
    do {
      const page = await inspectDiagnostic(path, {
        index,
        offset,
        maxCharacters: 1024,
      });
      assert.ok(page.content.length <= 1024);
      contents += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
  }
  assert.match(contents, /Choose test color/);
  assert.match(contents, /dataBase64/);
  assert.match(contents, /comparison/);
  assert.equal(contents.includes("EXCLUDED_PRIVATE_KEY_SOURCE"), false);
});

test("normal local export retains semantic replay, rejects overwrite and stale review, and shows corrupt versus truncated limits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cline-sdk-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = await capture(t, dir),
    review = await reviewDiagnostic(source);
  const destination = join(dir, "normal-copy"),
    copy = await exportDiagnostic(source, {
      destination,
      reviewToken: review.reviewToken,
    });
  const bundle = await readDiagnostic(copy.path),
    c = createClient({ mode: "replay" }),
    events = [];
  c.subscribe((e) => events.push(e));
  await c.openReplay(bundle.recording);
  await c.replayAll();
  assert.equal(compareDiagnostic(bundle, events, c.snapshot()).matches, true);
  c.close();
  await assert.rejects(
    exportDiagnostic(source, { destination, reviewToken: review.reviewToken }),
    { code: "diagnostic-export-exists" },
  );
  await assert.rejects(
    exportDiagnostic(source, {
      destination: source,
      reviewToken: review.reviewToken,
    }),
    { code: "diagnostic-export-original" },
  );
  const linked = join(dir, "linked-copy");
  await symlink(source, linked, "junction");
  await assert.rejects(
    exportDiagnostic(source, {
      destination: linked,
      reviewToken: review.reviewToken,
    }),
    { code: "diagnostic-export-exists" },
  );
  await assert.rejects(
    exportDiagnostic(source, {
      destination: join(dir, "identity-mask"),
      reviewToken: review.reviewToken,
      masks: [
        bundle.recording.observations.find((o) => o.kind === "initialize")
          .executionId,
      ],
    }),
    { code: "diagnostic-mask-identity" },
  );
  const journalPath = join(destination, "observations.ndjson"),
    lines = (await readFile(journalPath, "utf8")).trimEnd().split("\n");
  const first = JSON.parse(lines[0]);
  first.comparison.snapshot.revision += 100;
  lines[0] = JSON.stringify(first);
  await writeFile(journalPath, lines.join("\n") + "\n");
  await assert.rejects(readDiagnostic(destination), {
    code: "diagnostic-hash-mismatch",
  });
  assert.equal((await reviewDiagnostic(destination)).replay.state, "blocked");
  const truncated = await exportDiagnostic(source, {
    destination: join(dir, "truncated-copy"),
    reviewToken: review.reviewToken,
  });
  const raw = await readFile(
    join(truncated.path, "observations.ndjson"),
    "utf8",
  );
  await writeFile(
    join(truncated.path, "observations.ndjson"),
    raw.slice(0, raw.length - 20),
  );
  const partial = await reviewDiagnostic(truncated.path);
  assert.equal(partial.integrity.state, "truncated");
  assert.equal(partial.replay.state, "partial");
  assert.equal(
    (await readDiagnostic(truncated.path)).recording.provenance.truncated,
    true,
  );
  await writeFile(
    join(source, "manifest.json"),
    (await readFile(join(source, "manifest.json"), "utf8")) + " ",
  );
  await assert.rejects(
    exportDiagnostic(source, {
      destination: join(dir, "stale-copy"),
      reviewToken: review.reviewToken,
    }),
    { code: "diagnostic-review-stale" },
  );
});

test("selected sensitive text is masked in a new raw copy including split packets, and comparison never asserts equivalence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cline-sdk-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secret = Buffer.from("REVIEW_SECRET😀");
  const extras = [
    secret.subarray(0, 8),
    secret.subarray(8, secret.length - 2),
    secret.subarray(secret.length - 2),
  ].map((b, i) => ({
    kind: "pty",
    seq: 19 + i,
    observedAt: `2026-10-09T00:00:0${i}.000Z`,
    dataBase64: b.toString("base64"),
  }));
  const original = await capture(t, dir, extras),
    review = await reviewDiagnostic(original);
  const originalJournal = await readFile(join(original, "observations.ndjson")),
    originalManifest = await readFile(join(original, "manifest.json"));
  const preview = await previewDiagnosticExport(original, {
    reviewToken: review.reviewToken,
    masks: ["Choose test color", "REVIEW_SECRET😀"],
  });
  assert.ok(preview.transformations.every((m) => m.matchedOccurrences > 0));
  assert.equal(preview.replayImpact.comparison, "unavailable");
  assert.equal(JSON.stringify(preview).includes("REVIEW_SECRET"), false);
  const copied = await exportDiagnostic(original, {
    destination: join(dir, "masked-copy"),
    reviewToken: review.reviewToken,
    masks: ["Choose test color", "REVIEW_SECRET😀"],
  });
  assert.notEqual(copied.bundleId, review.bundleId);
  assert.equal(copied.metadata.export.source.bundleId, review.bundleId);
  assert.equal(
    copied.metadata.export.replayImpact.semanticEquivalence,
    "not-assumed",
  );
  const bundle = await readDiagnostic(copied.path),
    source = await readDiagnostic(original);
  assert.deepEqual(
    bundle.recording.observations.map((o) => [o.seq, o.observedAt]),
    source.recording.observations.map((o) => [o.seq, o.observedAt]),
  );
  assert.deepEqual(
    bundle.recording.observations.filter(
      (o) => o.kind === "initialize" || o.kind === "binding",
    ),
    source.recording.observations.filter(
      (o) => o.kind === "initialize" || o.kind === "binding",
    ),
  );
  const raw = Buffer.concat(
    bundle.recording.observations
      .filter((o) => o.kind === "pty")
      .map((o) => Buffer.from(o.dataBase64, "base64")),
  ).toString("utf8");
  assert.equal(raw.includes("REVIEW_SECRET"), false);
  let content = "";
  for (let index = 0; index < copied.items; index++) {
    let offset = 0;
    do {
      const p = await inspectDiagnostic(copied.path, {
        index,
        offset,
        maxCharacters: 16384,
      });
      content += p.content;
      offset = p.nextOffset;
    } while (offset !== null);
  }
  assert.equal(content.includes("Choose test color"), false);
  assert.equal(content.includes("REVIEW_SECRET"), false);
  const replay = createClient({ mode: "replay" }),
    events = [];
  replay.subscribe((e) => events.push(e));
  await replay.openReplay(bundle.recording);
  await replay.replayAll();
  assert.equal(
    compareDiagnostic(bundle, events, replay.snapshot()).available,
    false,
  );
  assert.equal(
    compareDiagnostic(bundle, events, replay.snapshot()).matches,
    false,
  );
  assert.deepEqual(
    await readFile(join(original, "observations.ndjson")),
    originalJournal,
  );
  assert.deepEqual(
    await readFile(join(original, "manifest.json")),
    originalManifest,
  );
  replay.close();
});
