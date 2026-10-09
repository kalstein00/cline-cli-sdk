import { readFile, stat, realpath, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SdkError } from "./reducer.js";

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
    state: "verified" | "truncated" | "corrupt";
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
async function load(path: string) {
  const root = await realpath(resolve(path));
  const mpath = join(root, "manifest.json"),
    jpath = join(root, "observations.ndjson");
  if (
    (await stat(mpath)).size > 65536 ||
    (await stat(jpath)).size > 256 * 1024 * 1024
  )
    throw new SdkError(
      "diagnostic-read-limit",
      "Diagnostic exceeds finite read limits.",
    );
  const manifest = await readFile(mpath, "utf8"),
    journal = await readFile(jpath, "utf8");
  let metadata;
  try {
    metadata = JSON.parse(manifest);
  } catch {
    throw new SdkError(
      "invalid-diagnostic",
      "Diagnostic manifest is not valid JSON.",
    );
  }
  if (
    metadata.format !== "cline-cli-sdk-diagnostic" ||
    metadata.schemaVersion !== 2
  )
    throw new SdkError("invalid-diagnostic", "Unknown diagnostic format.");
  const entries = [];
  let malformed = false,
    partialTail = false;
  const lines = journal.split("\n").filter(Boolean);
  for (const [i, line] of lines.entries())
    try {
      entries.push(JSON.parse(line));
    } catch {
      partialTail = i === lines.length - 1;
      malformed = !partialTail;
      entries.push({
        observation: { kind: "unparsed" },
        unparsedContent: line,
        __malformed: true,
      });
      break;
    }
  return { root, manifest, journal, metadata, entries, malformed, partialTail };
}
function summary(data: Awaited<ReturnType<typeof load>>): DiagnosticReview {
  const included = new Map<string, number>();
  for (const e of data.entries)
    included.set(
      e.observation.kind,
      (included.get(e.observation.kind) || 0) + 1,
    );
  const truncated =
    !!data.metadata.status?.truncated ||
    !data.metadata.stoppedAt ||
    data.partialTail ||
    (data.metadata.export?.journalBytes > Buffer.byteLength(data.journal) &&
      data.entries.filter((e) => !e.__malformed).length <
        data.metadata.export?.observations);
  const corrupt =
    data.malformed ||
    data.entries.some(
      (e) =>
        !e.__malformed &&
        (e.sha256 !== sha(JSON.stringify(e.observation)) ||
          (e.integritySha256 &&
            e.integritySha256 !==
              sha(
                JSON.stringify({
                  observation: e.observation,
                  comparison: e.comparison,
                }),
              ))),
    ) ||
    (!truncated &&
      data.metadata.export?.journalSha256 &&
      data.metadata.export.journalSha256 !== sha(data.journal));
  const state = corrupt ? "corrupt" : truncated ? "truncated" : "verified";
  const reason = corrupt
    ? "diagnostic-hash-mismatch"
    : truncated
      ? "Recording is incomplete; only the captured prefix can be replayed."
      : null;
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
  const walk = (value: any): any => {
    if (typeof value === "string") return replace(value);
    if (
      typeof value === "number" &&
      masks.some((s) => String(value).includes(s))
    )
      return replace(String(value));
    if (Array.isArray(value)) return value.map(walk);
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
          return [key, walk(v)];
        }),
      );
    return value;
  };
  const entries = structuredClone(data.entries.filter((e) => !e.__malformed)),
    streams = new Map<string, { o: any; b: Buffer }[]>();
  for (const e of entries) {
    e.observation = walk(e.observation);
    const o = e.observation;
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
          o.kind === "pty"
            ? `pty:${o.source ?? "packet"}`
            : `input:${o.binding?.requestId ?? o.requestId ?? o.seq}`;
        const list = streams.get(key) ?? [];
        list.push({ o, b });
        streams.set(key, list);
      }
    }
    if (masks.length) e.comparison = { events: [], snapshot: null };
  }
  for (const list of streams.values()) {
    const bytes = maskBytes(Buffer.concat(list.map((x) => x.b)), masks, counts);
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
  if (!inside || (!inside.startsWith("..") && !isAbsolute(inside)))
    throw new SdkError(
      "diagnostic-export-original",
      "Export outside the original recording directory.",
    );
  const masks = options.masks ?? [],
    changed = transform(data, masks);
  const journal = changed.entries.map((e) => JSON.stringify(e) + "\n").join("");
  const masked =
    masks.length > 0 || !!data.metadata.export?.replayImpact?.masked;
  const metadata = {
    ...changed.metadata,
    status: {
      ...changed.metadata.status,
      truncated: review.integrity.state === "truncated",
    },
    export: {
      bundleId: randomUUID(),
      exportedAt: new Date().toISOString(),
      source: {
        bundleId: review.bundleId,
        manifestSha256: review.integrity.manifestSha256,
        journalSha256: review.integrity.journalSha256,
        truncated: review.integrity.state === "truncated",
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
    },
  };
  const manifest = JSON.stringify(metadata),
    max = options.maxBytes ?? 16 * 1024 * 1024;
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
