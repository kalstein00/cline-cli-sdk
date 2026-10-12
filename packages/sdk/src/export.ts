import { realpath, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SdkError } from "./reducer.js";
import { loadDiagnosticFile as load, protectDiagnosticRows } from "./diagnostic-file.js";

const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export interface DiagnosticReview {
  path: string;
  bundleId: string;
  reviewToken: string;
  bytes: number;
  items: number;
  included: { kind: string; count: number }[];
  integrity: {
    state: "verified" | "truncated" | "limited" | "corrupt";
    reason: string | null;
    manifestSha256: string;
    journalSha256: string;
  };
  replay: { state: "ready" | "partial" | "blocked"; reason: string | null };
  credentials: {
    excludedSources: boolean;
    contentMayContainSecrets: true;
    note: string;
  };
  metadata: any;
}
function summary(data: Awaited<ReturnType<typeof load>>): DiagnosticReview {
  const included = new Map<string, number>();
  for (const e of data.entries)
    included.set(
      e.observation.kind,
      (included.get(e.observation.kind) || 0) + 1,
    );
  const state = data.integrityState;
  const corrupt = state === "corrupt";
  const truncated = data.truncated || data.limited;
  const reason = data.reason;
  return {
    path: data.root,
    bundleId:
      data.metadata.export?.bundleId ?? sha(data.manifest + data.journal),
    reviewToken: sha(data.manifest + data.journal),
    bytes: Buffer.byteLength(data.manifest) + Buffer.byteLength(data.journal),
    items: data.entries.length,
    included: [...included].map(([kind, count]) => ({ kind, count })),
    integrity: {
      state,
      reason,
      manifestSha256: sha(data.manifest),
      journalSha256: sha(data.journal),
    },
    replay: {
      state: corrupt ? "blocked" : truncated ? "partial" : "ready",
      reason,
    },
    credentials: {
      excludedSources: [
        "SSH configuration/key files",
        "provider/settings files",
      ].every((s) => data.metadata.exclusions?.includes(s)),
      contentMayContainSecrets: true,
      note: "Excluded source classes do not remove arbitrary secrets from conversation, PTY, tool arguments or answers. Review all contents before export.",
    },
    metadata: data.metadata,
  };
}

export interface DiagnosticExportOptions {
  destination: string;
  reviewToken: string;
  masks?: string[];
  maxBytes?: number;
}
const protectedKeys = new Set([
  "supersededBy",
  "index", "previousSha256", "rowFormat", "journalBytes", "integrityLimitation",
  "id",
  "bundleId",
  "sessionId",
  "executionId",
  "interactionId",
  "requestId",
  "toolId",
  "tool_use_id",
  "fromExecutionId",
  "nextExecutionId",
  "seq",
  "sourceSeq",
  "observedAt",
  "elapsedNs",
  "sha256",
  "sourceSha256",
  "manifestSha256",
  "journalSha256",
  "selectionSha256",
  "integritySha256",
  "cliHash",
  "answerDigest",
  "promptDigest",
  "modalHash",
  "fingerprint",
  "bootId",
  "startTime",
  "pid",
  "ppid",
  "pgid",
  "parentPid",
  "revision",
  "cursor",
  "epoch",
  "stepIndex",
  "inputType",
  "kind",
  "type",
  "action",
  "operation",
  "rows",
  "cols",
  "bytes",
  "observations",
  "maxBytes",
  "maxBundles",
  "retentionDays",
  "ownerPid",
  "schemaVersion",
  "adapterVersion",
]);
function transform(data: Awaited<ReturnType<typeof load>>, masks: string[]) {
  if (
    !Array.isArray(masks) ||
    masks.length > 64 ||
    masks.some((s) => typeof s !== "string" || s.length < 1 || s.length > 1024)
  )
    throw new SdkError(
      "invalid-diagnostic-masks",
      "Choose at most 64 literal strings of 1–1024 characters.",
    );
  const counts = masks.map(() => 0);
  const replace = (text: string) => {
    for (const [i, s] of masks.entries()) {
      const n = text.split(s).length - 1;
      counts[i] += n;
      text = text.split(s).join("*".repeat(s.length));
    }
    return text;
  };
  const guard = (value: any) => {
    if (
      (typeof value === "string" || typeof value === "number") &&
      masks.some((s) => String(value).includes(s))
    )
      throw new SdkError(
        "diagnostic-mask-identity",
        "Mask overlaps a preserved identifier, timestamp or integrity binding.",
      );
    if (value && typeof value === "object")
      for (const v of Object.values(value)) guard(v);
  };
  const walk = (value: any, nesting=0): any => {
    if (typeof value === "string") {
      let text=value;
      if(masks.length && /^[\s]*[\[{"]/.test(value)) {
        let decoded;
        try {decoded=JSON.parse(value);} catch {}
        if(decoded!==undefined && (typeof decoded==="string" || (decoded && typeof decoded==="object"))) {
          if(nesting>=16) throw new SdkError("diagnostic-mask-json-depth","Nested JSON content exceeds the masking review limit.");
          const changed=walk(decoded,nesting+1);
          if(JSON.stringify(changed)!==JSON.stringify(decoded)) text=JSON.stringify(changed);
        }
      }
      return replace(text);
    }
    if (
      typeof value === "number" &&
      masks.some((s) => String(value).includes(s))
    )
      return replace(String(value));
    if (Array.isArray(value)) return value.map(v=>walk(v,nesting));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => {
          if (protectedKeys.has(key) || key === "cli") {
            guard(v);
            return [key, v];
          }
          if (key === "dataBase64") return [key, v];
          if (masks.some((s) => key.includes(s)))
            throw new SdkError(
              "diagnostic-mask-key",
              "Selected text occurs in a structural key; choose a different review/mask scope.",
            );
          return [key, walk(v,nesting)];
        }),
      );
    return value;
  };
  const entries = structuredClone(data.entries.filter((e) => !e.__malformed)),
    streams = new Map<string, { o: any; b: Buffer }[]>();
  let streamExecution="unbound";
  for (const e of entries) {
    e.observation = walk(e.observation);
    const o = e.observation;
    if((o.kind==="initialize" || o.kind==="binding") && o.executionId) streamExecution=o.executionId;
    if (typeof o.dataBase64 === "string") {
      const b = Buffer.from(o.dataBase64, "base64");
      if (o.kind === "history") {
        try {
          o.dataBase64 = Buffer.from(
            JSON.stringify(walk(JSON.parse(b.toString("utf8")))),
          ).toString("base64");
        } catch (error) {
          if (error instanceof SdkError) throw error;
          const bytes = maskBytes(b, masks, counts);
          o.dataBase64 = bytes.toString("base64");
        }
      } else {
        const key =
          o.kind === "json-output" ? `json:${streamExecution}:${o.channel}` : o.kind === "pty"
            ? `pty:${streamExecution}:${o.source ?? "packet"}`
            : `input:${o.binding?.requestId ?? o.requestId ?? o.seq}`;
        const list = streams.get(key) ?? [];
        list.push({ o, b });
        streams.set(key, list);
      }
    }
    if (masks.length) e.comparison = { events: [], snapshot: null };
  }
  for (const [key,list] of streams) {
    let source=Buffer.concat(list.map((x) => x.b));
    if(masks.length && key.startsWith("json:") && key.endsWith(":stdout")) {
      const lines=source.toString("utf8").split("\n");
      source=Buffer.from(lines.map((line,index)=>{
        if(!line.trim()) return line;
        if(index===lines.length-1) throw new SdkError("diagnostic-mask-json-incomplete","Cannot semantically mask an incomplete JSON stream; inspect the captured raw content.");
        let decoded;
        try {decoded=JSON.parse(line);} catch {throw new SdkError("diagnostic-mask-json-incomplete","Cannot semantically mask malformed JSON output.");}
        const changed=walk(decoded);
        if(JSON.stringify(changed)===JSON.stringify(decoded)) return line;
        const encoded=JSON.stringify(changed);
        const padding=Buffer.byteLength(line)-Buffer.byteLength(encoded);
        if(padding<0) throw new SdkError("diagnostic-mask-json-size","This mask cannot retain JSON packet boundaries; choose the exact displayed raw text.");
        return encoded+" ".repeat(padding);
      }).join("\n"));
    }
    const bytes = maskBytes(source, masks, counts);
    let offset = 0;
    for (const item of list) {
      item.o.dataBase64 = bytes
        .subarray(offset, offset + item.b.length)
        .toString("base64");
      offset += item.b.length;
    }
  }
  for (const e of entries) {
    e.sha256 = sha(JSON.stringify(e.observation));
    e.integritySha256 = sha(
      JSON.stringify({ observation: e.observation, comparison: e.comparison }),
    );
  }
  return { entries, counts, metadata: walk(structuredClone(data.metadata)) };
}
function maskBytes(input: Buffer, masks: string[], counts: number[]) {
  const output = Buffer.from(input);
  for (const [i, text] of masks.entries()) {
    const needle = Buffer.from(text);
    let offset = 0;
    while ((offset = output.indexOf(needle, offset)) !== -1) {
      output.fill(42, offset, offset + needle.length);
      counts[i]++;
      offset += needle.length;
    }
  }
  return output;
}
export async function previewDiagnosticExport(
  path: string,
  options: { reviewToken: string; masks?: string[] },
) {
  const data = await load(path),
    review = summary(data);
  if (options.reviewToken !== review.reviewToken)
    throw new SdkError(
      "diagnostic-review-stale",
      "Review the current source before preparing a copy.",
    );
  if (review.integrity.state === "corrupt")
    throw new SdkError(
      "diagnostic-export-corrupt",
      "Corrupt observations cannot be prepared as a verified copy.",
    );
  const masks = options.masks ?? [],
    changed = transform(data, masks),
    masked = masks.length > 0 || !!data.metadata.export?.replayImpact?.masked;
  return {
    reviewToken: review.reviewToken,
    transformations: masks.map((s, i) => ({
      kind: "literal-mask",
      selectionSha256: sha(s),
      matchedOccurrences: changed.counts[i],
    })),
    replayImpact: {
      masked,
      semanticEquivalence: masked ? "not-assumed" : "unchanged-raw",
      comparison: masked ? "unavailable" : "retained",
      reason: masked
        ? "Selected raw content changed; original expected interpretation sidecar will be removed."
        : null,
    },
    preserved: {
      identifiers: true,
      sequence: true,
      timestamps: true,
      packetBoundaries: true,
    },
  };
}
export async function exportDiagnostic(
  path: string,
  options: DiagnosticExportOptions,
): Promise<DiagnosticReview> {
  const data = await load(path),
    review = summary(data);
  if (options.reviewToken !== review.reviewToken)
    throw new SdkError(
      "diagnostic-review-stale",
      "Review the current source before exporting.",
    );
  if (review.integrity.state === "corrupt")
    throw new SdkError(
      "diagnostic-export-corrupt",
      "Corrupt observations cannot be exported as a verified copy.",
    );
  const requested = resolve(options.destination),
    parent = await realpath(dirname(requested)),
    destination = join(parent, requested.split(/[\\/]/).at(-1)!);
  const inside = relative(data.root, destination);
  if (!inside || (inside.split(/[\\/]/)[0] !== ".." && !isAbsolute(inside)))
    throw new SdkError(
      "diagnostic-export-original",
      "Export outside the original recording directory.",
    );
  const masks = options.masks ?? [],
    changed = transform(data, masks);
  const protectedEntries = protectDiagnosticRows(changed.entries);
  const journal = protectedEntries.map((e) => JSON.stringify(e) + "\n").join("");
  const masked =
    masks.length > 0 || !!data.metadata.export?.replayImpact?.masked;
  const max = options.maxBytes ?? 16 * 1024 * 1024;
  const metadata = {
    ...changed.metadata,
    integrity: { rowFormat: "chained-v1", journalSha256: sha(journal), journalBytes: Buffer.byteLength(journal), observations: changed.entries.length },
    integrityLimitation: data.limited || !!data.metadata.integrityLimitation,
    status: {
      ...changed.metadata.status,
      maxBytes: max,
      observations: changed.entries.length,
      truncated: data.truncated || data.limited,
    },
    export: {
      bundleId: randomUUID(),
      exportedAt: new Date().toISOString(),
      source: {
        bundleId: review.bundleId,
        manifestSha256: review.integrity.manifestSha256,
        journalSha256: review.integrity.journalSha256,
        truncated: data.truncated || data.limited,
        capturedStatus: changed.metadata.status,
      },
      transformations: [
        ...(changed.metadata.export?.transformations ?? []),
        ...(data.partialTail
          ? [
              {
                kind: "discard-incomplete-tail",
                sha256: sha(data.entries.at(-1).unparsedContent),
                bytes: Buffer.byteLength(data.entries.at(-1).unparsedContent),
              },
            ]
          : []),
        ...masks.map((s, i) => ({
          kind: "literal-mask",
          selectionSha256: sha(s),
          matchedOccurrences: changed.counts[i],
        })),
      ],
      preserved: {
        identifiers: true,
        sequence: true,
        timestamps: true,
        packetBoundaries: true,
      },
      replayImpact: {
        masked,
        semanticEquivalence: masked ? "not-assumed" : "unchanged-raw",
        comparison: masked ? "unavailable" : "retained",
        reason: masked
          ? "Selected raw content changed; original expected interpretation sidecar was removed."
          : null,
      },
      journalSha256: sha(journal),
      journalBytes: Buffer.byteLength(journal),
      observations: changed.entries.length,
      maxBytes: max,
    },
  };
  let manifest = JSON.stringify(metadata);
  for (let n = 0; n < 8; n++) {
    const bytes = Buffer.byteLength(manifest) + Buffer.byteLength(journal);
    if (metadata.status.bytes === bytes) break;
    metadata.status.bytes = bytes;
    manifest = JSON.stringify(metadata);
  }
  if (!Number.isInteger(max) || max < 4096 || max > 256 * 1024 * 1024)
    throw new SdkError(
      "invalid-diagnostic-export-limit",
      "Choose a 4 KiB–256 MiB export limit.",
    );
  if (
    Buffer.byteLength(manifest) > 65536 ||
    Buffer.byteLength(manifest) + Buffer.byteLength(journal) > max
  )
    throw new SdkError(
      "diagnostic-export-limit",
      "Export copy exceeds its finite size limit.",
    );
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new SdkError(
        "diagnostic-export-exists",
        "Export destination already exists; choose a new path.",
      );
    throw error;
  }
  await writeFile(join(destination, "observations.ndjson"), journal, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(destination, "manifest.json"), manifest, {
    flag: "wx",
    mode: 0o600,
  });
  return reviewDiagnostic(destination);
}
export async function reviewDiagnostic(
  path: string,
): Promise<DiagnosticReview> {
  return summary(await load(path));
}
export interface DiagnosticContentPage {
  index: number;
  kind: string;
  content: string;
  totalCharacters: number;
  nextOffset: number | null;
}
export async function inspectDiagnostic(
  path: string,
  options: {
    index: number;
    offset?: number;
    maxCharacters?: number;
    reviewToken?: string;
  },
): Promise<DiagnosticContentPage> {
  const offset = options.offset ?? 0,
    max = options.maxCharacters ?? 4096;
  if (
    !Number.isInteger(options.index) ||
    options.index < 0 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(max) ||
    max < 1 ||
    max > 16384
  )
    throw new SdkError(
      "invalid-diagnostic-page",
      "Choose an item and a page of 1–16384 characters.",
    );
  const data = await load(path),
    entry = data.entries[options.index];
  if (options.reviewToken && options.reviewToken !== summary(data).reviewToken)
    throw new SdkError(
      "diagnostic-review-stale",
      "Source changed; review it again before paging its content.",
    );
  if (!entry)
    throw new SdkError(
      "diagnostic-item-missing",
      "Diagnostic item is outside this recording.",
    );
  const decode = (value: any): any =>
    Array.isArray(value)
      ? value.map(decode)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).flatMap(([k, v]) =>
              k === "dataBase64" && typeof v === "string"
                ? [
                    [k, v],
                    ["decodedData", Buffer.from(v, "base64").toString("utf8")],
                  ]
                : [[k, decode(v)]],
            ),
          )
        : value;
  const content = JSON.stringify(decode(entry), null, 2);
  return {
    index: options.index,
    kind: entry.observation.kind,
    content: content.slice(offset, offset + max),
    totalCharacters: content.length,
    nextOffset: offset + max < content.length ? offset + max : null,
  };
}
