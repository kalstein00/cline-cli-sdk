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
const pinned = {
  platform: "Linux",
  python: true,
  pty: true,
  tmux: "tmux 3.4",
  cliPath: "/fixture/cline",
  cliVersion: "3.0.69", cliFlags:['--cwd','--data-dir','--auto-approve','--tui','--id','--json','--retries','--zen'],
  cliHash: "8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032",
  bootId: "boot-1",
};
