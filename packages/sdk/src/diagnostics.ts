import {
  mkdir,
  mkdtemp,
  writeFile,
  appendFile,
  readFile,
  readdir,
  stat,
  lstat,
  unlink,
  rmdir,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  SdkError,
  type Recording,
  type Observation,
  type SdkEvent,
  type Snapshot,
} from "./reducer.js";

export interface DiagnosticOptions {
  directory: string;
  maxBytes?: number;
  maxBundles?: number;
  retentionDays?: number;
}
export interface DiagnosticStatus {
  state: "inactive" | "collecting" | "stopped" | "limit-reached" | "failed";
  path: string | null;
  bytes: number;
  observations: number;
  truncated: boolean;
  maxBytes: number;
  maxBundles: number;
  retentionDays: number;
  failure: string | null;
}
export interface DiagnosticBundle {
  recording: Recording;
  comparison: { events: SdkEvent[]; snapshot: Snapshot | null };
  metadata: any;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const initial = (): DiagnosticStatus => ({
  state: "inactive",
  path: null,
  bytes: 0,
  observations: 0,
  truncated: false,
  maxBytes: 16 * 1024 * 1024,
  maxBundles: 5,
  retentionDays: 7,
  failure: null,
});
const projection = (s: Snapshot | null) =>
  s ? (({ mode, replay, ...rest }) => rest)(s) : null;
export function compareDiagnostic(
  bundle: DiagnosticBundle,
  events: SdkEvent[],
  snapshot: Snapshot,
) {
  let eventDifferences = 0;
  for (
    let i = 0;
    i < Math.max(events.length, bundle.comparison.events.length);
    i++
  )
    if (
      JSON.stringify(events[i]) !== JSON.stringify(bundle.comparison.events[i])
    )
      eventDifferences++;
  const snapshotMatches =
    JSON.stringify(projection(snapshot)) ===
    JSON.stringify(projection(bundle.comparison.snapshot));
  return {
    matches: eventDifferences === 0 && snapshotMatches,
    eventDifferences,
    snapshotMatches,
  };
}
export function createDiagnosticCollector() {
  let status = initial();
  let queue = Promise.resolve();
  let lastSnapshot: Snapshot | null = null;
  let header: any = null;
  let startedAt = "";
  let manifestBytes = 0;
  let journalBytes = 0;
  let reserve = 2048;
  let finalized=true;
  const fail = (error: unknown) => {
    status.state = "failed";
    status.truncated = true;
    status.failure = (error as NodeJS.ErrnoException).code ?? "storage-failed";
  };
  const enqueue = (action: () => Promise<void>) => {
    queue = queue.then(action).catch(fail);
  };
  return {
    status: () => structuredClone(status),
    partial(reason: string) {
      status.truncated = true;
      header.gaps = [...(header.gaps ?? []), reason];
    },
    async start(options: DiagnosticOptions) {
      if (!finalized)
        throw new SdkError(
          "diagnostics-active",
          "Stop the current diagnostic collection first.",
        );
      const limits = {
        maxBytes: options.maxBytes ?? 16 * 1024 * 1024,
        maxBundles: options.maxBundles ?? 5,
        retentionDays: options.retentionDays ?? 7,
      };
      if (
        !options.directory ||
        !Number.isInteger(limits.maxBytes) ||
        limits.maxBytes < 4096 ||
        limits.maxBytes > 256 * 1024 * 1024 ||
        !Number.isInteger(limits.maxBundles) ||
        limits.maxBundles < 1 ||
        limits.maxBundles > 50 ||
        !Number.isInteger(limits.retentionDays) ||
        limits.retentionDays < 1 ||
        limits.retentionDays > 90
      )
        throw new SdkError(
          "invalid-diagnostics-options",
          "Choose a directory, 4 KiB–256 MiB, 1–50 bundles and 1–90 retention days.",
        );
      status = { ...initial(), ...limits, state: "collecting" };
      finalized=false;
      lastSnapshot = null;
      queue = Promise.resolve();
      startedAt = new Date().toISOString();
      journalBytes = 0;
      manifestBytes = 0;
      reserve = Math.min(
        65536,
        Math.max(2048, Math.floor(limits.maxBytes / 8)),
      );
      header = {
        format: "cline-cli-sdk-diagnostic",
        schemaVersion: 2,
        sdkVersion: "0.1.0",
        adapterVersion: 1,
        ownerPid:process.pid,
        startedAt,
        limits,
        exclusions: [
          "SSH configuration/key files",
          "provider/settings files",
          "history system_prompt/provider/model/thinking/metrics fields",
        ],
        contentReview:
          "Conversation, tool arguments, PTY and responses can contain sensitive content; review before export.",
      };
      try {
        const root = resolve(options.directory);
        await mkdir(root, { recursive: true, mode: 0o700 });
        const owned = [];
        let protectedCount=0;
        for (const name of await readdir(root)) {
          if (!/^cline-sdk-diag-[A-Za-z0-9]+$/.test(name)) continue;
          const path = join(root, name);
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink()) continue;
          const entries = await readdir(path);
          if (
            entries.some(
              (entry) =>
                !["manifest.json", "observations.ndjson"].includes(entry),
            )
          )
            continue;
          try {
            const m = JSON.parse(
              await readFile(join(path, "manifest.json"), "utf8"),
            );
            if(m.format!==header.format)continue;
            let ownerAlive=false;
            if(!m.stoppedAt) {
              if(!Number.isInteger(m.ownerPid))ownerAlive=true;
              else try{process.kill(m.ownerPid,0);ownerAlive=true;}catch(error){ownerAlive=(error as NodeJS.ErrnoException).code!=="ESRCH";}
            }
            if(ownerAlive)protectedCount++;else owned.push({ path, time: Date.parse(m.startedAt) });
          } catch {}
        }
        owned.sort((a, b) => b.time - a.time);
        if(protectedCount>=limits.maxBundles)throw Object.assign(new Error("Active diagnostics occupy the finite bundle limit."),{code:"diagnostic-bundle-limit"});
        for (const [index, item] of owned.entries())
          if (
            index >= limits.maxBundles - protectedCount - 1 ||
            Date.now() - item.time > limits.retentionDays * 86400000
          ) {
            if (dirname(item.path) !== root)
              throw new Error("retention-path-outside-directory");
            // Remove only the two SDK-owned files; unknown user files prevent rmdir.
            await unlink(join(item.path, "observations.ndjson")).catch(
              () => {},
            );
            await unlink(join(item.path, "manifest.json")).catch(() => {});
            await rmdir(item.path).catch(() => {});
          }
        status.path = await mkdtemp(join(root, "cline-sdk-diag-"));
        await writeFile(join(status.path, "observations.ndjson"), "", {
          mode: 0o600,
          flag: "wx",
        });
        const manifest = JSON.stringify({
          ...header,
          status: { ...status, path: undefined },
        });
        manifestBytes = Buffer.byteLength(manifest);
        status.bytes = manifestBytes;
        await writeFile(join(status.path, "manifest.json"), manifest, {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        fail(error);
        if(!status.path)finalized=true;
      }
      return structuredClone(status);
    },
    capture(observation: Observation, events: SdkEvent[], snapshot: Snapshot) {
      if (status.state !== "collecting") return;
      const obs = structuredClone(observation);
      if (obs.kind === "initialize")
        header.source = {
          cli: obs.cli,
          cliHash: obs.cliHash,
          terminal: obs.terminal,
          executionId: obs.executionId,
          sessionId: obs.sessionId,
        };
      if (obs.kind === "history") {
        try {
          const original = JSON.parse(
            Buffer.from(obs.dataBase64, "base64").toString("utf8"),
          );
          const filtered = {
            version: original.version,
            sessionId: original.sessionId,
            messages: original.messages?.filter((m:any)=>m.role!=="system").map((m: any) => ({
              id: m.id,
              role: m.role,
              content: m.content
                ?.filter((p: any) =>
                  ["text", "tool_use", "tool_result"].includes(p.type),
                )
                .map((p: any) =>
                  p.type === "text"
                    ? { type: p.type, text: p.text }
                    : p.type === "tool_use"
                      ? { type: p.type, id: p.id, name: p.name, input: p.input }
                      : {
                          type: p.type,
                          tool_use_id: p.tool_use_id,
                          content: p.content,
                          is_error: p.is_error,
                        },
                ),
            })),
          };
          obs.dataBase64 = Buffer.from(JSON.stringify(filtered)).toString(
            "base64",
          );
        } catch {
          obs.dataBase64 = Buffer.from("{invalid-history-observation").toString(
            "base64",
          );
        }
      }
      const line =
        JSON.stringify({
          observation: obs,
          sha256: sha(JSON.stringify(obs)),
          comparison: { events, snapshot },
        }) + "\n";
      const bytes = Buffer.byteLength(line);
      if (journalBytes + bytes > status.maxBytes - reserve) {
        status.state = "limit-reached";
        status.truncated = true;
        return;
      }
      journalBytes += bytes;
      status.bytes = journalBytes + manifestBytes;
      status.observations++;
      lastSnapshot = structuredClone(snapshot);
      const path = status.path!;
      enqueue(async () => {
        await appendFile(join(path, "observations.ndjson"), line);
      });
    },
    async stop() {
      if (status.state === "inactive") return structuredClone(status);
      if (status.state === "collecting") status.state = "stopped";
      await queue;
      if (status.path)
        try {
          const stoppedAt=new Date().toISOString();
          let manifest = JSON.stringify({
            ...header,
            stoppedAt,
            status: { ...status, path: undefined },
          });
          manifestBytes = Buffer.byteLength(manifest);
          if (journalBytes + manifestBytes > status.maxBytes)
            throw Object.assign(new Error("metadata-limit"), {
              code: "metadata-limit",
            });
          status.bytes = journalBytes + manifestBytes;
          for(let n=0;n<3;n++){manifest=JSON.stringify({...header,stoppedAt,status:{...status,path:undefined}});status.bytes=journalBytes+Buffer.byteLength(manifest);}
          await writeFile(join(status.path, "manifest.json"), manifest, {
            mode: 0o600,
          });
        } catch (error) {
          fail(error);
        }
      finalized=true;
      return structuredClone(status);
    },
  };
}
export async function readDiagnostic(path: string): Promise<DiagnosticBundle> {
  const root = resolve(path);
  const manifestPath = join(root, "manifest.json");
  if ((await stat(manifestPath)).size > 65536)
    throw new SdkError(
      "diagnostic-read-limit",
      "Diagnostic metadata exceeds finite read limit.",
    );
  const metadata = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    metadata.format !== "cline-cli-sdk-diagnostic" ||
    metadata.schemaVersion !== 2
  )
    throw new SdkError("invalid-diagnostic", "Unknown diagnostic format.");
  const file = join(root, "observations.ndjson");
  if ((await stat(file)).size > 256 * 1024 * 1024)
    throw new SdkError(
      "diagnostic-read-limit",
      "Diagnostic file exceeds finite read limit.",
    );
  const observations: Observation[] = [];
  const events: SdkEvent[] = [];
  let lastSnapshot: Snapshot | null = null;
  const content = await readFile(file, "utf8");
  metadata.status.bytes=Buffer.byteLength(content)+(await stat(manifestPath)).size;
  let truncated = !!metadata.status.truncated||!metadata.stoppedAt;
  for (const line of content.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      truncated = true;
      break;
    }
    if (entry.sha256 !== sha(JSON.stringify(entry.observation)))
      throw new SdkError(
        "diagnostic-hash-mismatch",
        "A raw observation changed after collection.",
      );
    observations.push(entry.observation);
    events.push(...entry.comparison.events);
    lastSnapshot = entry.comparison.snapshot;
  }
  return {
    recording: {
      schemaVersion: 2,
      interpretation: "live",
      cli: { name: "cline", version: "unknown", profile: "unknown" },
      terminal: { rows: 40, cols: 120 },
      sessionId: null,
      executionId: null,
      observations,
      provenance: {
        source: "SDK diagnostics",
        sourceSha256: sha(content),
        review: metadata.contentReview,
        transformations: metadata.exclusions,
        complete: !!metadata.stoppedAt && !truncated,
        truncated,
      },
    },
    comparison: { events, snapshot: lastSnapshot },
    metadata,
  };
}
