// Validate captured evidence. This does not replay a CLI adapter or execute input.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node summarize.mjs <local observation directory>');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
let snapshots = 0;
for (const row of summary) {
  if (!/^[a-zA-Z0-9_-]+$/.test(row.run)) throw new Error('Invalid run identifier');
  const recording = fs.readFileSync(path.join(directory, 'logs', row.run, 'frames.ndjson'));
  if (sha256(recording) !== row.frames_sha256) throw new Error(`Recording hash mismatch: ${row.run}`);
  const events = recording.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
  if (events.length !== row.events || events[0].kind !== 'start') throw new Error(`Invalid recording: ${row.run}`);
  let elapsed = -1;
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1 || event.elapsed_ns < elapsed) throw new Error(`Invalid event order: ${row.run}`);
    elapsed = event.elapsed_ns;
    if (event.kind === 'file_snapshot') {
      if (!/^(sessions\/[^/]+\/[^/]+\.json|tasks\/[^/]+\/(ui_messages|api_conversation_history|task_metadata)\.json)$/.test(event.path)) {
        throw new Error(`Unexpected snapshot path: ${event.path}`);
      }
      const payload = Buffer.from(event.data_b64, 'base64');
      if (sha256(payload) !== event.sha256) throw new Error(`Snapshot hash mismatch: ${row.run}`);
      let valid = true;
      try { JSON.parse(payload.toString('utf8')); } catch { valid = false; }
      if (valid !== event.complete_json) throw new Error(`Invalid snapshot annotation: ${row.run}`);
      snapshots++;
    }
  }
}
console.log(JSON.stringify({
  recordings: summary.length, snapshots, hashesMatch: true, eventOrderValid: true,
  snapshotPathsRestricted: true,
  note: 'Recording integrity only; not SDK behavior or company CLI acceptance.',
}, null, 2));
