import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createClient } from "@cline-cli-sdk/sdk";
import { readFile } from "node:fs/promises";

test("unavailable OpenSSH reports a bounded connection failure without unhandled input errors", async () => {
  const client = createClient({
    mode: "live",
    connection: {
      host: "fixture-alias",
      sshExecutable: "cline-sdk-no-such-ssh-ticket-3",
      timeoutMs: 100,
    },
  });
  await assert.rejects(client.connect(), { code: "ssh-unavailable" });
  assert.equal(client.snapshot().connection, "disconnected");
  client.close();
});

// Only the external OpenSSH process is substituted. All SDK state handling is real.
function remote(t, responses) {
  t.mock.method(childProcess, "spawn", () => {
    const process = new EventEmitter();
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.stdin = new PassThrough();
    process.kill = () => {};
    let input = "";
    process.stdin.on("data", (data) => (input += data));
    process.stdin.on("finish", () => {
      const response = responses.shift();
      const value =
        typeof response === "function" ? response(JSON.parse(input)) : response;
      process.stdout.end(JSON.stringify(value));
      queueMicrotask(() => process.emit("close", 0, null));
    });
    return process;
  });
}
test("live preflight preserves an unknown company profile and blocks task launch", async (t) => {
  remote(t, [
    {
      platform: "Linux",
      python: true,
      pty: true,
      tmux: "tmux 3.4",
      cliPath: "/fixture/cline",
      cliVersion: "company-unknown",
      cliHash: "unknown",
      bootId: "boot-1",
    },
  ]);
  const client = createClient({
    mode: "live",
    connection: { host: "fixture-alias", cliPath: "/fixture/cline" },
  });
  const report = await client.connect();
  assert.equal(report.profile.supported, false);
  assert.equal(report.profile.companyCompatibility, "unverified");
  await assert.rejects(
    client.start({ cwd: "/fixture/work", prompt: "Hello" }),
    { code: "unsupported-profile" },
  );
  assert.equal(client.snapshot().execution, "unknown");
  client.close();
});
test("concurrent start requests select one managed execution before remote launch", async (t) => {
  remote(t, [
    pinned,
    (request) => ({
      executionId: request.executionId,
      remoteRoot: "/fixture/control",
    }),
    (request) => ({
      executionId: request.executionId,
      remoteRoot: "/fixture/control",
    }),
  ]);
  const client = createClient({
    mode: "live",
    connection: { host: "fixture-alias" },
  });
  await client.connect();
  const attempts = await Promise.allSettled([
    client.start({ cwd: "/fixture/work", prompt: "first" }),
    client.start({ cwd: "/fixture/work", prompt: "second" }),
  ]);
  assert.equal(attempts[0].status, "fulfilled");
  assert.equal(attempts[1].status, "rejected");
  assert.equal(attempts[1].reason.code, "managed-execution-selected");
  client.close();
});
test("unchanged live history and liveness polling retain the same public revision", async (t) => {
  const observed = (request) => ({
    executionId: request.executionId,
    sessionId: "fixture-session",
    observations: [],
    cursor: 0,
    process: {
      identity: { pid: 42, startTime: "100", bootId: "boot-1" },
      alive: true,
      identityConfirmed: true,
      exitCode: null,
      manifestStatus: "pending",
    },
  });
  remote(t, [
    pinned,
    (request) => ({
      executionId: request.executionId,
      remoteRoot: "/fixture/control",
    }),
    observed,
    observed,
  ]);
  const client = createClient({
    mode: "live",
    connection: { host: "fixture-alias" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "Hello" });
  const first = await client.refresh();
  const second = await client.refresh();
  assert.equal(second.revision, first.revision);
  client.close();
});
test("missing remote Python is reported as an actionable prerequisite", async (t) => {
  remote(t, [
    { error: "python-unavailable", message: "Remote Python 3 is required." },
  ]);
  const client = createClient({
    mode: "live",
    connection: { host: "fixture-alias" },
  });
  const report = await client.connect();
  assert.equal(report.ready, false);
  assert.deepEqual(report.problems, ["python-unavailable"]);
  client.close();
});
test("missing exit witness and stale process identity remain unknown instead of successful", async (t) => {
  remote(t, [
    pinned,
    (request) => ({
      executionId: request.executionId,
      remoteRoot: "/fixture/control",
    }),
    (request) => ({
      executionId: request.executionId,
      observations: [],
      cursor: 0,
      process: {
        identity: { pid: 42, startTime: "100", bootId: "old-boot" },
        alive: false,
        identityConfirmed: false,
        exitCode: 0,
        manifestStatus: "completed",
      },
    }),
  ]);
  const client = createClient({
    mode: "live",
    connection: { host: "fixture-alias", cliPath: "/fixture/cline" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "Hello" });
  await client.refresh();
  assert.equal(client.snapshot().execution, "unknown");
  client.close();
});
test("bounded observation gap blocks stale questions until terminal state can be resynchronized", async (t) => {
  const recording = JSON.parse(
    await readFile(
      new URL("../fixtures/question.json", import.meta.url),
      "utf8",
    ),
  );
  remote(t, [
    pinned,
    (request) => ({
      executionId: request.executionId,
      remoteRoot: "/fixture/control",
    }),
    (request) => ({
      executionId: request.executionId,
      observations: recording.observations,
      cursor: 20,
      gap: true,
      process: {
        identity: { pid: 42, startTime: "100", bootId: "boot-1" },
        alive: true,
        identityConfirmed: true,
        exitCode: null,
        manifestStatus: "pending",
      },
    }),
  ]);
  const client = createClient({
    mode: "live",
    connection: { host: "fixture-alias", cliPath: "/fixture/cline" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "Hello" });
  await client.refresh();
  assert.equal(client.snapshot().execution, "unknown");
  assert.equal(client.snapshot().interaction?.state, "unsupported");
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
test("live consumer starts one managed task and sees recorded messages with witnessed completion", async (t) => {
  const recording = JSON.parse(
    await readFile(
      new URL("../fixtures/live-completion.json", import.meta.url),
      "utf8",
    ),
  );
  remote(t, [
    pinned,
    (request) => ({
      executionId: request.executionId,
      remoteRoot: "/fixture/control",
    }),
    (request) => ({
      executionId: request.executionId,
      sessionId: "fixture-live-session",
      observations: recording.observations,
      cursor: 7,
    }),
  ]);
  const client = createClient({
    mode: "live",
    connection: { host: "fixture-alias", cliPath: "/fixture/cline" },
  });
  await client.connect();
  await client.start({ cwd: "/fixture/work", prompt: "Controlled color run" });
  await client.refresh();
  assert.equal(
    client.snapshot().messages.find((m) => m.role === "assistant").text,
    "SDK_LIVE_READY",
  );
  assert.equal(client.snapshot().execution, "completed");
  await assert.rejects(
    client.start({ cwd: "/fixture/work", prompt: "second" }),
    { code: "managed-execution-selected" },
  );
  client.close();
});
