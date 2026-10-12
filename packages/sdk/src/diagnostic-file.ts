import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { SdkError } from "./reducer.js";

export const diagnosticHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** The full observation and comparison form one ordered, chained journal row. */
export function protectDiagnosticRows(entries: any[]) {
  let previousSha256 = "";
  return entries.map((entry, index) => {
    const row = protectDiagnosticRow(entry, index, previousSha256);
    previousSha256 = row.integritySha256;
    return row;
  });
}
export function protectDiagnosticRow(entry: any, index: number, previousSha256: string) {
  const row = { ...entry, index, previousSha256 };
  row.sha256 = diagnosticHash(JSON.stringify(row.observation));
  row.integritySha256 = diagnosticHash(JSON.stringify({
    index, previousSha256, observation: row.observation, comparison: row.comparison,
  }));
  return row;
}

export async function loadDiagnosticFile(path: string) {
  const root = await realpath(resolve(path));
  const mpath = join(root, "manifest.json"), jpath = join(root, "observations.ndjson");
  if ((await stat(mpath)).size > 65536 || (await stat(jpath)).size > 256 * 1024 * 1024)
    throw new SdkError("diagnostic-read-limit", "Diagnostic exceeds finite read limits.");
  const manifest = await readFile(mpath, "utf8"), journal = await readFile(jpath, "utf8");
  let metadata;
  try { metadata = JSON.parse(manifest); }
  catch { throw new SdkError("invalid-diagnostic", "Diagnostic manifest is not valid JSON."); }
  if (metadata.format !== "cline-cli-sdk-diagnostic" || metadata.schemaVersion !== 2)
    throw new SdkError("invalid-diagnostic", "Unknown diagnostic format.");
  const entries: any[] = [];
  let corrupt = false, partialTail = false, previousSha256 = "", previousSeq = 0;
  const lines = journal.split("\n").filter(Boolean);
  const expected = metadata.integrity ?? metadata.export;
  const chained = expected?.rowFormat === "chained-v1";
  for (const [index, line] of lines.entries()) {
    let entry;
    try { entry = JSON.parse(line); }
    catch {
      partialTail = index === lines.length - 1 && !journal.endsWith("\n");
      if (!partialTail) corrupt = true;
      entries.push({ observation: { kind: "unparsed" }, unparsedContent: line, __malformed: true });
      break;
    }
    if (!entry || typeof entry !== "object" || !entry.observation || typeof entry.observation.kind !== "string") {
      corrupt = true;
      entries.push({ observation: { kind: "unparsed" }, unparsedContent: line, __malformed: true });
      break;
    }
    const payload = chained
      ? { index: entry.index, previousSha256: entry.previousSha256, observation: entry.observation, comparison: entry.comparison }
      : { observation: entry.observation, comparison: entry.comparison };
    if (!entry.observation || !entry.comparison || !Array.isArray(entry.comparison.events) ||
        entry.sha256 !== diagnosticHash(JSON.stringify(entry.observation)) ||
        (entry.integritySha256 && entry.integritySha256 !== diagnosticHash(JSON.stringify(payload))) ||
        (chained && (!entry.integritySha256 || entry.index !== index || entry.previousSha256 !== previousSha256)) ||
        !Number.isInteger(entry.observation?.seq) || entry.observation.seq <= previousSeq)
      corrupt = true;
    previousSha256 = entry.integritySha256;
    previousSeq = entry.observation?.seq;
    entries.push(entry);
  }
  const count = entries.filter(e => !e.__malformed).length;
  const hasFinalIntegrity = typeof expected?.journalSha256 === "string" &&
    Number.isInteger(expected?.journalBytes) && Number.isInteger(expected?.observations);
  // A torn final row is partial only when every preceding row is independently
  // verified in its original order. Dropped complete rows are corruption.
  const provenTail = partialTail && chained && hasFinalIntegrity &&
    count < expected.observations && Buffer.byteLength(journal) < expected.journalBytes;
  if (hasFinalIntegrity &&
      (expected.journalSha256 !== diagnosticHash(journal) || expected.journalBytes !== Buffer.byteLength(journal) || expected.observations !== count) &&
      !provenTail) corrupt = true;
  if (partialTail && !provenTail && metadata.stoppedAt && hasFinalIntegrity) corrupt = true;
  if (!hasFinalIntegrity && metadata.stoppedAt && Number.isInteger(metadata.status?.observations) &&
      count !== metadata.status.observations && !partialTail) corrupt = true;
  const limited = !!metadata.integrityLimitation || !hasFinalIntegrity || (!chained && entries.some(e => !e.__malformed && !e.integritySha256));
  const truncated = !!metadata.status?.truncated || !metadata.stoppedAt || partialTail;
  const integrityState: "corrupt" | "limited" | "truncated" | "verified" = corrupt ? "corrupt" : limited ? "limited" : truncated ? "truncated" : "verified";
  const reason = corrupt ? "diagnostic-hash-mismatch" : limited
    ? "Legacy or unfinished recording lacks finalized full-row/order/count integrity; full equivalence is unverified."
    : truncated ? "Recording is incomplete; only the verified captured prefix can be replayed." : null;
  return { root, manifest, journal, metadata, entries, partialTail, integrityState, reason, truncated, limited };
}
