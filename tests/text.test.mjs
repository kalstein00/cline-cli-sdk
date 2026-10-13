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
import {createHash} from 'node:crypto';
const pinned = {
  platform: "Linux",
  python: true,
  pty: true,
  tmux: "tmux 3.4",
  cliPath: "/fixture/cline",
  cliVersion: "3.0.69", cliFlags:['--cwd','--data-dir','--auto-approve','--tui','--id','--json','--retries','--zen'],
  cliHash: "8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032",
  bootId: "boot",
};
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

test('actual wrapped approval reconstructs complete arguments and rejects missing or changed continuation',async()=>{
 const original=JSON.parse(await readFile(new URL('../fixtures/chat/wrapped-approval.json',import.meta.url)));
 for(const fault of ['none','changed','missing']){
  const r=structuredClone(original);const frame=r.observations.at(-1);
  const raw=Buffer.from(frame.dataBase64,'base64').toString();
  if(fault==='changed')frame.dataBase64=Buffer.from(raw.replace(' 파일:', ' 삭제:')).toString('base64');
  if(fault==='missing')frame.dataBase64=Buffer.from(raw.replace(/\r\n 파일:[^\r\n]*/, '')).toString('base64');
  const c=createClient({mode:'replay'});await c.openReplay(r);await c.replayAll();
  assert.equal(c.snapshot().interaction.kind,fault==='none'?'approval':'unsupported',fault);
  if(fault==='none')assert.match(c.snapshot().interaction.toolInput.commands[0],/find .*malo -type f \| wc -l$/);
  c.close();
 }
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
