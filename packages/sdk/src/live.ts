import childProcess from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { deliveryState, type DurableResponse } from "./delivery.js";
import {
  createReducer,
  SdkError,
  type Snapshot,
  type SdkEvent,
  type ResponseRequest,
  type ResponseResult,
  type StopRequest,
  type StopResult,
} from "./reducer.js";

export interface ConnectionOptions {
  host: string;
  cliPath?: string;
  identityFile?: string;
  user?: string;
  port?: number;
  sshExecutable?: string;
  remoteRoot?: string;
  timeoutMs?: number;
  responseTimeoutMs?: number;
}
export interface LiveOptions {
  mode: "live";
  connection: ConnectionOptions;
}
export interface PreflightReport {
  platform: string;
  python: boolean;
  pty: boolean;
  processOwnership?: boolean;
  tmux: string | null;
  cliPath: string | null;
  cliVersion: string | null;
  cliHash: string | null;
  bootId: string;
  problems: string[];
  ready: boolean;
  profile: {
    name: string;
    supported: boolean;
    companyCompatibility: "unverified";
  };
}
export interface StartRequest {
  /** readline keeps its numeric-prefix limitation; TUI supports verified custom input. */
  terminalMode?: "readline" | "tui";
  cwd: string;
  prompt: string;
  dataDir?: string;
  retryLimit?: number;
}
export interface ResumeRequest {
  executionId: string;
  requestId: string;
  prompt: string;
}
export interface ManagedExecution {
  terminalMode?: "readline" | "tui";
  executionId: string;
  remoteRoot: string;
  sessionId: string | null;
  alive?: boolean;
  identityConfirmed?: boolean;
  terminal?: { rows: number; cols: number };
  cliHash?: string;
}
export interface LiveClient {
  preflight(): Promise<PreflightReport>;
  connect(): Promise<PreflightReport>;
  disconnect(): void;
  listManagedExecutions(): Promise<ManagedExecution[]>;
  attach(executionId: string): Promise<Snapshot>;
  reconfirmDelivery(): Promise<Snapshot>;
  start(request: StartRequest): Promise<Snapshot>;
  resume(request: ResumeRequest): Promise<Snapshot>;
  refresh(): Promise<Snapshot>;
  snapshot(): Snapshot;
  subscribe(listener: (event: SdkEvent) => void): () => void;
  capabilities(): {
    replay: false;
    live: true;
    responses: true;
    freeText: boolean;
    companyCompatibility: "unverified";
  };
  respond(request: ResponseRequest): Promise<ResponseResult>;
  stop(request: StopRequest): Promise<StopResult>;
  close(): void;
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export function createLiveClient(options: LiveOptions): LiveClient {
  const config = structuredClone(options.connection);
  if (
    !config.host ||
    config.host.startsWith("-") ||
    /[\r\n\0]/.test(config.host)
  )
    throw new SdkError(
      "invalid-connection",
      "A host or SSH alias is required.",
    );
  if (
    config.responseTimeoutMs !== undefined &&
    (!Number.isInteger(config.responseTimeoutMs) ||
      config.responseTimeoutMs < 250 ||
      config.responseTimeoutMs > 120000)
  )
    throw new SdkError(
      "invalid-response-timeout",
      "Response observation timeout must be 250–120000 milliseconds.",
    );
  let phase: any = null;
  let pendingPhase: any = null;
  let phaseSupported = false;
  let reservationSupported = false;
  const reducer = createReducer({
    mode: "replay",
    interactionIdentity(kind, toolId, prompt, choices) {
      if (!phaseSupported) return undefined;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([kind, toolId, prompt, choices]))
        .digest("hex");
      if (phase?.active && phase.fingerprint === fingerprint) return phase.id;
      pendingPhase = {
        fingerprint,
        epoch: (phase?.epoch ?? 0) + 1,
        id: `${managed?.executionId}:phase:${(phase?.epoch ?? 0) + 1}:${fingerprint.slice(0, 16)}`,
        active: true,
      };
      return pendingPhase.id;
    },
  });
  let state: Snapshot = { ...reducer.snapshot(), mode: "live" };
  let report: PreflightReport | null = null;
  let managed: ManagedExecution | null = null;
  let cursor = 0;
  let sequence = 0;
  let historyHash: string | null = null;
  let refreshing: Promise<Snapshot> | null = null;
  let observationGap = false;
  let closed = false;
  let generation = 0;
  let fullSynchronization = false;
  let processEvidence: any = null;
  let remoteRequests: any[] = [];
  let activeRequest: string | null = null;
  let stopPromise: Promise<StopResult> | null = null;
  let stopRequestId: string | null = null;
  let terminalMode: "readline" | "tui" = "readline";
  let modalHash: string | null = null;
  let composerHash: string | null = null;
  let resumeActive = false;
  const resumes = new Map<string, { binding: string; promise: Promise<Snapshot> }>();
  const requests = new Map<
    string,
    { binding: string; promise: Promise<ResponseResult> }
  >();
  const processes = new Set<ReturnType<typeof childProcess.spawn>>();
  const listeners = new Set<(e: SdkEvent) => void>();
  const snapshot = () => structuredClone(state);
  reducer.subscribe((event) => {
    state = {
      ...reducer.snapshot(),
      mode: "live",
      connection: state.connection,
    };
    for (const listener of listeners) listener(event);
  });
  const execute = async (code: string, input: unknown): Promise<any> => {
    if (closed)
      throw new SdkError("client-closed", "Create a new client after close.");
    const operationGeneration = generation;
    const args = [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=30",
    ];
    if (config.identityFile)
      args.push("-i", config.identityFile, "-o", "IdentitiesOnly=yes");
    if (config.user) args.push("-l", config.user);
    if (config.port) args.push("-p", String(config.port));
    args.push(
      config.host,
      `if command -v python3 >/dev/null 2>&1; then python3 -c ${quote(code)}; else printf '%s' '{"error":"python-unavailable","message":"Remote Python 3 is required."}'; fi`,
    );
    return await new Promise((resolve, reject) => {
      const process = childProcess.spawn(config.sshExecutable ?? "ssh", args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      processes.add(process);
      let stdout = "";
      let stderr = "";
      const deadline = setTimeout(() => {
        process.kill();
        reject(new SdkError("ssh-timeout", "SSH operation timed out."));
      }, config.timeoutMs ?? 45000);
      process.stdout.on("data", (data) => {
        stdout += data;
        if (stdout.length > 8 * 1024 * 1024) {
          process.kill();
          reject(
            new SdkError(
              "remote-response-limit",
              "Remote response exceeded the bounded read limit.",
            ),
          );
        }
      });
      process.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-2000);
      });
      process.stdin.on("error", () => {
        /* The SSH error/close witness determines the result. */
      });
      process.on("error", (error) => {
        processes.delete(process);
        clearTimeout(deadline);
        reject(new SdkError("ssh-unavailable", error.message));
      });
      process.on("close", (code) => {
        processes.delete(process);
        clearTimeout(deadline);
        if (closed || operationGeneration !== generation) {
          reject(
            new SdkError(
              "connection-interrupted",
              "The local connection was detached during this operation.",
            ),
          );
          return;
        }
        if (code !== 0)
          reject(
            new SdkError("ssh-failed", stderr.trim() || `SSH exited ${code}`),
          );
        else
          try {
            const value = JSON.parse(stdout);
            if (value.error) reject(new SdkError(value.error, value.message));
            else resolve(value);
          } catch {
            reject(
              new SdkError(
                "invalid-remote-response",
                "Remote helper did not return valid JSON.",
              ),
            );
          }
      });
      process.stdin.end(JSON.stringify(input));
    });
  };
  const preflight = async () => {
    let found;
    try {
      found = await execute(PREFLIGHT, { cliPath: config.cliPath ?? null });
    } catch (error) {
      if (
        !(
          error instanceof SdkError &&
          ["python-unavailable", "python-version-unsupported"].includes(
            error.code,
          )
        )
      )
        throw error;
      report = {
        platform: "unknown",
        python: false,
        pty: false,
        tmux: null,
        cliPath: null,
        cliVersion: null,
        cliHash: null,
        bootId: "",
        problems: [error.code],
        ready: false,
        profile: {
          name: "unknown",
          supported: false,
          companyCompatibility: "unverified",
        },
      };
      return structuredClone(report);
    }
    const problems: string[] = [];
    if (found.platform !== "Linux") problems.push("linux-required");
    if (!found.pty) problems.push("pty-unavailable");
    if (!found.tmux) problems.push("tmux-unavailable");
    if (found.processOwnership === false) problems.push("pidfd-unavailable");
    if (!found.cliPath)
      problems.push(
        found.discovery === "login-shell-failed"
          ? "cli-discovery-inconclusive"
          : "cli-not-installed",
      );
    else if (found.discovery === "login-shell")
      problems.push("noninteractive-path-mismatch");
    else if (!found.cliVersion) problems.push("cli-not-executable");
    const supported =
      found.cliVersion === "3.0.69" &&
      found.cliHash ===
        "8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032";
    if (!supported) problems.push("unsupported-profile");
    report = {
      ...found,
      python: true,
      problems,
      ready: problems.every((p) => p === "noninteractive-path-mismatch"),
      profile: {
        name: supported ? "cline-3.0.69-readline" : "unknown",
        supported,
        companyCompatibility: "unverified",
      },
    };
    return structuredClone(report!);
  };
  const helper = async (input: unknown) => {
    const helperGeneration = generation;
    const source = await readFile(
      new URL("../remote/supervisor.py", import.meta.url),
    );
    const ownership = await readFile(
      new URL("../remote/ownership.py", import.meta.url),
    );
    const resumeSource = await readFile(new URL("../remote/resume.py", import.meta.url));
    if (closed || generation !== helperGeneration)
      throw new SdkError(
        "connection-interrupted",
        "The local connection was detached before this operation.",
      );
    return execute(
      `import base64,io,json,sys,types;request=json.load(sys.stdin);module=types.ModuleType('resume');exec(base64.b64decode(request['resumeSourceBase64']),module.__dict__);sys.modules['resume']=module;sys.stdin=io.StringIO(json.dumps(request));exec(base64.b64decode(request['sourceBase64']))`,
      {
        sourceBase64: source.toString("base64"),
        ownershipSourceBase64: ownership.toString("base64"),
        resumeSourceBase64: resumeSource.toString("base64"),
        ...(input as object),
      },
    );
  };
  const refresh = () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (!managed)
        throw new SdkError("no-managed-execution", "Start a task first.");
      if (state.connection !== "connected")
        throw new SdkError("not-connected", "Connect before refreshing.");
      const result = await helper({
        action: "status",
        root: managed.remoteRoot,
        executionId: managed.executionId,
        cursor,
        fullScreen: fullSynchronization || observationGap,
      });
      if (result.executionId !== managed.executionId)
        throw new SdkError(
          "execution-mismatch",
          "Remote execution identity did not match.",
        );
      if (closed)
        throw new SdkError(
          "client-closed",
          "The client was closed during synchronization.",
        );
      if (result.sessionId) {
        managed.sessionId = result.sessionId;
        reducer.setContext({ sessionId: result.sessionId });
      }
      phaseSupported = !!result.management?.phaseSupported;
      reservationSupported = !!result.management?.responseReservation;
      phase = result.phase ?? phase;
      pendingPhase = null;
      for (const raw of result.screen ? [] : (result.observations ?? []))
        await reducer.ingest({ ...raw, seq: ++sequence });
      cursor = result.cursor;
      remoteRequests = result.requests ?? [];
      modalHash = result.modalHash ?? null;
      composerHash = result.composerHash ?? null;
      processEvidence = result.process ?? processEvidence;
      if (result.history && result.history.sha256 !== historyHash) {
        try {
          await reducer.ingest({
            kind: "history",
            seq: ++sequence,
            observedAt: new Date().toISOString(),
            dataBase64: result.history.dataBase64,
          });
          historyHash = result.history.sha256;
        } catch (error) {
          if (!(error instanceof SdkError && error.code === "invalid-history"))
            throw error;
        }
      }
      if (result.screen) {
        await reducer.ingest({
          kind: "pty",
          seq: ++sequence,
          observedAt: new Date().toISOString(),
          dataBase64: result.screen.dataBase64,
        });
        observationGap = false;
        fullSynchronization = false;
      }
      if (result.process)
        await reducer.ingest({
          ...result.process,
          seq: ++sequence,
          observedAt: new Date().toISOString(),
        });
      observationGap ||= !!result.gap && !result.screen;
      if (
        pendingPhase &&
        !observationGap &&
        reducer.snapshot().interaction?.id === pendingPhase.id
      ) {
        const persisted = await helper({
          action: "bind-phase",
          root: managed.remoteRoot,
          executionId: managed.executionId,
          fingerprint: pendingPhase.fingerprint,
          interactionId: pendingPhase.id,
        });
        phase = persisted.phase;
      } else if (!reducer.snapshot().interaction && phase?.active) {
        phase = (
          await helper({
            action: "bind-phase",
            root: managed.remoteRoot,
            executionId: managed.executionId,
            fingerprint: null,
          })
        ).phase;
      }
      if (
        !reducer.snapshot().stop &&
        observationGap &&
        reducer.snapshot().interaction?.id !==
          `${managed.executionId}:observation-gap`
      ) {
        const current = reducer.snapshot();
        reducer.setContext({
          execution: "unknown",
          interaction: {
            id: `${managed.executionId}:observation-gap`,
            revision: current.revision + 1,
            kind: "unsupported",
            state: "unsupported",
            prompt:
              "Terminal observations were dropped. Resynchronization is required before responding.",
            choices: [],
          },
        });
      }
      state = { ...reducer.snapshot(), mode: "live", connection: "connected" };
      if (!activeRequest) {
        const receipts = remoteRequests.filter(
          (receipt): receipt is DurableResponse =>
            receipt.binding?.executionId === managed!.executionId &&
            receipt.binding?.sessionId === state.sessionId &&
            typeof receipt.binding?.answerDigest === "string",
        );
        const receipt =
          receipts
            .filter(
              (receipt) =>
                !receipt.resolution &&
                (receipt.state === "queued" || receipt.state === "written"),
            )
            .at(-1) ?? receipts.at(-1);
        if (receipt) {
          const resolved = deliveryState(
            receipt,
            state,
            reducer.toolResult(receipt.binding.toolId),
            processEvidence,
          );
          const next = {
            requestId: receipt.requestId,
            sessionId: receipt.binding.sessionId,
            executionId: receipt.binding.executionId,
            interactionId: receipt.binding.interactionId,
            revision: state.revision,
            state: resolved,
          };
          if (!receipt.resolution && resolved !== "delivery-unknown") {
            await helper({
              action: "settle-response",
              root: managed!.remoteRoot,
              executionId: managed!.executionId,
              requestId: receipt.requestId,
              resolution: resolved,
            });
            receipt.resolution = resolved as "delivered" | "not-submitted";
          }
          if (
            !state.response ||
            [
              "requestId",
              "sessionId",
              "executionId",
              "interactionId",
              "state",
            ].some(
              (key) =>
                state.response![key as keyof ResponseResult] !==
                next[key as keyof ResponseResult],
            )
          ) {
            reducer.setResponse(next);
            state = {
              ...reducer.snapshot(),
              mode: "live",
              connection: "connected",
            };
          }
        }
      }
      return snapshot();
    })()
      .catch((error) => {
        state = {
          ...reducer.snapshot(),
          mode: "live",
          connection: closed ? "closed" : "disconnected",
        };
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };
  const validateResponse = (request: ResponseRequest) => {
    if (state.stop)
      throw new SdkError(
        "stop-in-progress",
        "This execution has a stop request; response input is blocked.",
      );
    if (closed || state.connection !== "connected")
      throw new SdkError("not-connected", "A live connection is required.");
    if (
      !managed ||
      request.sessionId !== state.sessionId ||
      request.executionId !== state.executionId
    )
      throw new SdkError(
        "response-target-mismatch",
        "The response belongs to another session or execution.",
      );
    if (request.interactionId !== state.interaction?.id)
      throw new SdkError(
        "stale-interaction",
        "This interaction is no longer current.",
      );
    if (request.revision !== state.revision)
      throw new SdkError(
        "stale-revision",
        "Refresh the current interaction before responding.",
      );
    const interaction = state.interaction;
    if (
      observationGap ||
      interaction.state !== "awaiting-response" ||
      !interaction.toolId ||
      !interaction.responseKinds?.length
    )
      throw new SdkError(
        "interaction-unavailable",
        "This interaction does not support a verified response.",
      );
    if (
      typeof request.answer !== "string" ||
      (!interaction.choices.includes(request.answer) &&
        !interaction.responseKinds.includes("text"))
    )
      throw new SdkError(
        "unsupported-answer",
        "This interaction does not support that response.",
      );
    if (
      !interaction.choices.includes(request.answer) &&
      (!request.answer ||
        request.answer.trim() !== request.answer ||
        /[\p{Cc}\p{Cs}]/u.test(request.answer) ||
        Buffer.byteLength(request.answer) > 1024 ||
        [
          ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            request.answer,
          ),
        ].some(({ segment }) => Buffer.byteLength(segment) > 64) ||
        (terminalMode === "readline" &&
          Number.parseInt(request.answer, 10) >= 1 &&
          Number.parseInt(request.answer, 10) <= interaction.choices.length))
    )
      throw new SdkError(
        "unsupported-answer",
        "Use printable text up to 1024 UTF-8 bytes without outer whitespace. Readline cannot preserve a leading choice number; start a TUI task for that answer.",
      );
    if (!processEvidence?.alive || !processEvidence.identityConfirmed)
      throw new SdkError(
        "execution-unconfirmed",
        "The managed process identity is not confirmed alive.",
      );
  };
  return {
    preflight,
    async connect() {
      if (closed)
        throw new SdkError("client-closed", "Create a new client after close.");
      const currentGeneration = ++generation;
      state.connection = "connecting";
      try {
        const found = await preflight();
        if (closed || generation !== currentGeneration)
          throw new SdkError(
            "connection-interrupted",
            "Connection was detached.",
          );
        state.connection = "connected";
        return found;
      } catch (error) {
        state.connection = closed ? "closed" : "disconnected";
        throw error;
      }
    },
    disconnect() {
      generation++;
      for (const process of processes) process.kill();
      processes.clear();
      state.connection = closed ? "closed" : "disconnected";
      fullSynchronization = true;
    },
    async listManagedExecutions() {
      if (state.connection !== "connected")
        throw new SdkError(
          "not-connected",
          "Connect before listing managed executions.",
        );
      const result = await helper({ action: "list", root: config.remoteRoot });
      return structuredClone(result.executions);
    },
    async attach(executionId) {
      if (!report?.profile.supported || !report.ready)
        throw new SdkError(
          "unsupported-profile",
          "A verified CLI profile and ready environment are required before attaching.",
        );
      if (!/^run-[a-f0-9-]{36}$/.test(executionId))
        throw new SdkError(
          "invalid-execution",
          "Select a managed execution from the list.",
        );
      if (managed && managed.executionId !== executionId)
        throw new SdkError(
          "managed-execution-selected",
          "This client already controls another execution.",
        );
      if (!managed) {
        const runs = await this.listManagedExecutions();
        const found = runs.find((run) => run.executionId === executionId);
        if (!found)
          throw new SdkError(
            "unmanaged-execution",
            "Only SDK-started executions can be attached.",
          );
        if (found.cliHash && found.cliHash !== report.cliHash)
          throw new SdkError(
            "unsupported-profile",
            "The stored execution uses a different CLI fingerprint.",
          );
        managed = found;
        if (
          found.terminalMode !== undefined &&
          !["readline", "tui"].includes(found.terminalMode)
        )
          throw new SdkError(
            "unsupported-profile",
            "The managed terminal mode is not verified.",
          );
        terminalMode = found.terminalMode ?? "readline";
        cursor = 0;
        sequence = 0;
        historyHash = null;
        phase = null;
        await reducer.openReplay({
          schemaVersion: 1,
          cli: {
            name: "cline",
            version: "3.0.69",
            profile: `cline-3.0.69-${terminalMode}`,
          },
          terminal: found.terminal ?? { rows: 40, cols: 120 },
          sessionId: found.sessionId ?? executionId,
          executionId,
          observations: [],
          provenance: {
            source: "live",
            sourceSha256: "",
            review: "remote synchronization",
            transformations: [],
            complete: false,
            truncated: false,
          },
        });
        reducer.setContext({
          mode: "live",
          connection: "connected",
          sessionId: found.sessionId,
        });
      }
      fullSynchronization = true;
      return refresh();
    },
    async start(request) {
      if (!report?.profile.supported)
        throw new SdkError(
          "unsupported-profile",
          "The CLI profile has not been verified.",
        );
      if (!report.ready)
        throw new SdkError(
          "prerequisites-unavailable",
          "Resolve the reported environment prerequisites.",
        );
      if (state.connection !== "connected")
        throw new SdkError("not-connected", "Connect before starting.");
      if (managed)
        throw new SdkError(
          "managed-execution-selected",
          "This client already controls a managed execution.",
        );
      if (
        (request.terminalMode !== undefined &&
          !["readline", "tui"].includes(request.terminalMode)) ||
        !request.cwd.startsWith("/") ||
        !request.prompt.trim() ||
        request.prompt.length > 100000 ||
        (request.retryLimit !== undefined &&
          (!Number.isInteger(request.retryLimit) ||
            request.retryLimit < 1 ||
            request.retryLimit > 10))
      )
        throw new SdkError(
          "invalid-task",
          "An absolute remote directory and bounded text prompt are required.",
        );
      const executionId = "run-" + randomUUID();
      terminalMode = request.terminalMode ?? "readline";
      // Reserve identity before the first await. An uncertain launch is never retried.
      managed = {
        executionId,
        remoteRoot: config.remoteRoot ?? "~/.local/state/cline-cli-sdk",
        sessionId: null,
      };
      let launched;
      try {
        launched = await helper({
          action: "start",
          root: config.remoteRoot,
          executionId,
          cliPath: report.cliPath,
          cliHash: report.cliHash,
          ...request,
        });
      } catch (error) {
        state = reducer.setContext({
          executionId,
          sessionId: null,
          mode: "live",
          execution: "unknown",
          connection: closed ? "closed" : "disconnected",
        });
        throw error;
      }
      if (launched.executionId !== executionId)
        throw new SdkError(
          "execution-mismatch",
          "Remote launch identity did not match.",
        );
      managed = launched;
      if (closed)
        throw new SdkError(
          "client-closed",
          "The client was closed during task launch.",
        );
      await reducer.openReplay({
        schemaVersion: 1,
        cli: {
          name: "cline",
          version: "3.0.69",
          profile: `cline-3.0.69-${terminalMode}`,
        },
        terminal: { rows: 40, cols: 120 },
        sessionId: executionId,
        executionId: managed!.executionId,
        observations: [],
        provenance: {
          source: "live",
          sourceSha256: "",
          review: "live source",
          transformations: [],
          complete: false,
          truncated: false,
        },
      });
      reducer.setContext({
        sessionId: null,
        executionId: managed!.executionId,
        connection: "connected",
        mode: "live",
      });
      state = reducer.snapshot();
      return snapshot();
    },
    resume(input) {
      const request = structuredClone(input);
      if (!request || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId) ||
          typeof request.prompt !== "string" || !request.prompt || request.prompt.trim() !== request.prompt ||
          Buffer.byteLength(request.prompt) > 112 || /[\p{Cc}\p{Cs}]/u.test(request.prompt) || request.prompt.startsWith("/") || request.prompt.includes("@"))
        return Promise.reject(new SdkError("invalid-resume", "Use printable one-row text up to 112 UTF-8 bytes without outer whitespace, slash commands or mentions."));
      const binding = JSON.stringify([request.executionId, request.requestId, request.prompt]);
      const previous = resumes.get(request.requestId);
      if (previous) return previous.binding === binding ? previous.promise : Promise.reject(new SdkError("request-conflict", "Resume request identity is already bound."));
      if (resumeActive || resumes.size)
        return Promise.reject(new SdkError("resume-already-requested", "A resume launch has already been reserved; do not retry another identity."));
      if (!report?.profile.supported || !report.ready)
        return Promise.reject(new SdkError("unsupported-profile", "Resume requires the verified CLI profile."));
      if (!managed || request.executionId !== managed.executionId)
        return Promise.reject(new SdkError("resume-target-mismatch", "Attach the ended managed execution before resuming."));
      const promise = (async () => {
      await refresh();
      if (!state.sessionId || !["completed", "stopped"].includes(state.execution) ||
          processEvidence?.alive !== false || !processEvidence.identityConfirmed ||
          processEvidence.exitCode === null || processEvidence.supervisorAlive !== false ||
          processEvidence.childrenVerified !== true || processEvidence.children?.length ||
          (state.stop && (state.stop.state !== "confirmed" || !state.stop.childrenVerified || state.stop.remaining.length)))
        throw new SdkError("resume-unconfirmed", "Confirm CLI, supervisor and all owned children ended before resuming.");
      resumeActive = true;
      const fromExecutionId = managed!.executionId;
      const sessionId = state.sessionId;
      const baseline = structuredClone(state.messages);
      const executionId = "run-" + randomUUID();
      const digest = createHash("sha256").update(request.prompt).digest("hex");
      const receipt = {requestId: request.requestId, fromExecutionId, executionId, sessionId, state: "submitting" as const};
      reducer.setContext({resume:receipt});
      try {
        const launched = await helper({ action: "resume", root: managed!.remoteRoot,
          executionId: fromExecutionId, newExecutionId: executionId, requestId: request.requestId,
          prompt: request.prompt, cliPath: report!.cliPath, cliHash: report!.cliHash });
        if (!launched.executionId || launched.sessionId !== sessionId)
          throw new SdkError("resume-target-mismatch", "Remote resume did not preserve the conversation.");
        managed = launched;
        terminalMode = "tui";
        cursor = 0; sequence = 0; historyHash = null; phase = null; pendingPhase = null;
        processEvidence = null; observationGap = false; fullSynchronization = true;
        stopPromise = null; stopRequestId = null;
        await reducer.openReplay({schemaVersion:1,cli:{name:"cline",version:"3.0.69",profile:"cline-3.0.69-tui"},
          terminal:{rows:40,cols:120},sessionId,executionId:launched.executionId,observations:[],
          provenance:{source:"live",sourceSha256:"",review:"managed resume",transformations:[],complete:false,truncated:false}});
        const base = {...receipt,executionId:launched.executionId};
        reducer.setContext({mode:"live",connection:"connected",resume:base});
        const wait = async (condition:()=>boolean) => {
          const deadline = Date.now() + (config.responseTimeoutMs ?? 30000);
          while (Date.now() < deadline) {
            await refresh();
            if (state.executionId !== launched.executionId || state.sessionId !== sessionId || !processEvidence?.alive || !processEvidence.identityConfirmed || observationGap)
              throw new SdkError("resume-input-uncertain", "The resumed process/session is no longer confirmed.");
            if (condition()) return;
            if (state.interaction) throw new SdkError("resume-input-uncertain", "A modal owns the resumed input destination.");
            await new Promise(ok=>setTimeout(ok,100));
          }
          throw new SdkError("resume-input-uncertain", "Composer echo or new user history was not confirmed.");
        };
        await wait(()=>state.composer?.text === "" && !!composerHash && baseline.every(m=>state.messages.some(n=>m.id===n.id&&m.text===n.text)));
        let stepIndex = 0;
        const step = async (inputType:string, text:string, condition:()=>boolean) => {
          const index = stepIndex++;
          const queued = await helper({action:"respond",root:managed!.remoteRoot,executionId:managed!.executionId,
            sessionId,requestId:request.requestId,interactionId:`${managed!.executionId}:composer`,revision:state.revision,
            kind:"composer",answerDigest:digest,stepIndex:index,inputType,dataBase64:Buffer.from(text).toString("base64"),
            modalHash:composerHash,historyHash,processIdentity:processEvidence.identity,expectedCursor:cursor});
          if (queued.state === "rejected") throw new SdkError("resume-input-uncertain", queued.reason ?? "Composer input rejected.");
          await wait(()=>remoteRequests.some(r=>r.requestId===request.requestId&&r.steps?.some((s:any)=>s.index===index&&s.state==="written"))&&condition());
        };
        let part = "", accumulated = "";
        const chunks:string[]=[];
        for (const {segment} of new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(request.prompt)) {
          if (Buffer.byteLength(part+segment)>64) {chunks.push(part);part="";}
          part+=segment;
        }
        if(part)chunks.push(part);
        for(const chunk of chunks){accumulated+=chunk;await step("composer-text",chunk,()=>state.composer?.text===accumulated);}
        await step("composer-submit","\r",()=>state.messages.some(m=>m.role==="user"&&m.text===request.prompt&&!baseline.some(n=>n.id===m.id)));
        const witness = await helper({action:"settle-resume",root:managed!.remoteRoot,executionId:managed!.executionId,requestId:request.requestId});
        if(witness.state!=="delivered"||witness.executionId!==managed!.executionId||witness.sessionId!==sessionId)
          throw new SdkError("resume-input-uncertain","The stored follow-up receipt did not match.");
        reducer.setContext({resume:{...base,state:"delivered"}});
        state={...reducer.snapshot(),mode:"live",connection:state.connection};
        return snapshot();
      } catch(error) {
        reducer.setContext({resume:{...receipt,executionId:managed?.executionId ?? executionId,state:"delivery-unknown"}});
        state={...reducer.snapshot(),mode:"live",connection:state.connection};
        throw error;
      }
      })();
      resumes.set(request.requestId,{binding,promise});
      promise.catch(()=>{if(!resumeActive)resumes.delete(request.requestId);});
      return promise;
    },
    refresh,
    reconfirmDelivery: refresh,
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    capabilities() {
      return {
        replay: false,
        live: true,
        responses: true,
        freeText: !!state.interaction?.responseKinds?.includes("text"),
        companyCompatibility: "unverified",
      };
    },
    async respond(input) {
      if (!input || typeof input !== "object")
        throw new SdkError(
          "invalid-response",
          "A bound response request is required.",
        );
      const request = structuredClone(input);
      if (
        typeof request.requestId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)
      )
        throw new SdkError(
          "invalid-request-id",
          "Use a bounded stable response request ID.",
        );
      const binding = JSON.stringify([
        request.sessionId,
        request.executionId,
        request.interactionId,
        request.revision,
        request.requestId,
        request.answer,
      ]);
      if (request.executionId !== state.executionId || request.sessionId !== state.sessionId)
        throw new SdkError("response-target-mismatch", "The response belongs to another session or execution.");
      const existing = requests.get(request.requestId);
      if (existing) {
        if (existing.binding !== binding)
          throw new SdkError(
            "request-conflict",
            "This request ID is already bound to a different response.",
          );
        if (
          state.response?.requestId === request.requestId &&
          ["delivered", "not-submitted"].includes(state.response.state)
        )
          return structuredClone(state.response);
        return existing.promise;
      }
      const durable = remoteRequests.find(
        (receipt) => receipt.requestId === request.requestId && receipt.binding,
      );
      if (durable) {
        const expected = durable.binding;
        if (
          expected.sessionId !== request.sessionId ||
          expected.executionId !== request.executionId ||
          expected.interactionId !== request.interactionId ||
          expected.revision !== request.revision ||
          expected.answerDigest !==
            createHash("sha256").update(request.answer).digest("hex")
        )
          throw new SdkError(
            "request-conflict",
            "This durable request ID is already bound to another response.",
          );
        const resolved = deliveryState(
          durable,
          state,
          reducer.toolResult(expected.toolId),
          processEvidence,
        );
        return {
          requestId: request.requestId,
          sessionId: expected.sessionId,
          executionId: expected.executionId,
          interactionId: expected.interactionId,
          revision: state.revision,
          state: resolved,
        };
      }
      if (activeRequest || state.response?.state === "delivery-unknown")
        throw new SdkError(
          "response-busy",
          "A response is submitting or its delivery is unknown.",
        );
      if (requests.size >= 256)
        throw new SdkError(
          "response-request-limit",
          "This execution has reached its bounded response request limit.",
        );
      validateResponse(request);
      activeRequest = request.requestId;
      const promise = (async () => {
        let sent = false;
        let writeAttempted = false;
        try {
          await refresh();
          validateResponse(request);
          const interaction = structuredClone(state.interaction!);
          const custom = !interaction.choices.includes(request.answer);
          let bytes =
            interaction.kind === "approval"
              ? request.answer === "Approve"
                ? "y\r"
                : "n\r"
              : `${interaction.choices.indexOf(request.answer) + 1}\r`;
          if (terminalMode === "tui") bytes = bytes.slice(0, -1);
          const base = {
            requestId: request.requestId,
            sessionId: request.sessionId,
            executionId: request.executionId,
            interactionId: request.interactionId,
            revision: state.revision,
          };
          reducer.setResponse({ ...base, state: "submitting" });
          state = {
            ...reducer.snapshot(),
            connection: state.connection,
            mode: "live",
          };
          sent = true;
          const envelope = {
            action: "respond",
            root: managed!.remoteRoot,
            executionId: managed!.executionId,
            sessionId: request.sessionId,
            interactionId: request.interactionId,
            requestId: request.requestId,
            revision: request.revision,
            kind: interaction.kind,
            toolId: interaction.toolId,
            answerDigest: createHash("sha256")
              .update(request.answer)
              .digest("hex"),
            expectedCursor: cursor,
            historyHash,
            processIdentity: processEvidence.identity,
          };
          if (reservationSupported) {
            const reserved = await helper({
              ...envelope,
              modalHash,
              action: "reserve-response",
            });
            if (reserved.state === "rejected")
              throw new SdkError(
                "input-rejected",
                reserved.reason ??
                  "Response reservation was rejected before input.",
              );
            if (reserved.state !== "reserved")
              throw new SdkError(
                "response-already-reserved",
                "Reconcile the earlier response request before writing.",
              );
          }
          let anyWritten = false;
          if (custom && terminalMode === "tui") {
            const deadline = Date.now() + (config.responseTimeoutMs ?? 30000);
            let stepIndex = 0;
            const step = async (
              inputType: string,
              text: string,
              witness: () => boolean,
            ) => {
              if (
                state.interaction?.id !== interaction.id ||
                !processEvidence?.alive ||
                !processEvidence.identityConfirmed ||
                observationGap ||
                !modalHash
              )
                throw new SdkError(
                  "input-uncertain",
                  "The current TUI destination is no longer confirmed.",
                );
              writeAttempted = true;
              const accepted = await helper({
                ...envelope,
                inputType,
                stepIndex,
                modalHash,
                expectedCursor: cursor,
                historyHash,
                processIdentity: processEvidence.identity,
                dataBase64: Buffer.from(text).toString("base64"),
              });
              if (accepted.state === "rejected")
                throw new SdkError(
                  anyWritten ? "input-uncertain" : "input-rejected",
                  accepted.reason ??
                    "Remote TUI input was rejected before write.",
                );
              while (Date.now() < deadline) {
                await refresh();
                const receipt = remoteRequests
                  .filter((r) => r.requestId === request.requestId)
                  .flatMap((r) => r.steps ?? [])
                  .find((s) => s.index === stepIndex);
                if (receipt?.state === "rejected")
                  throw new SdkError(
                    anyWritten ? "input-uncertain" : "input-rejected",
                    receipt.reason ?? "TUI step rejected before write.",
                  );
                if (receipt?.state === "written") anyWritten = true;
                if (receipt?.state === "written" && witness()) {
                  stepIndex++;
                  return;
                }
                if (
                  state.interaction?.id !== interaction.id &&
                  inputType !== "tui-submit"
                )
                  throw new SdkError(
                    "input-uncertain",
                    "TUI phase changed before echo confirmation.",
                  );
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              throw new SdkError(
                "input-uncertain",
                "TUI echo or submission was not confirmed before the observation deadline.",
              );
            };
            const selected = state.interaction?.input?.selected;
            if (selected === null || selected === undefined)
              throw new SdkError(
                "input-rejected",
                "TUI selection is not visible.",
              );
            if (selected !== interaction.choices.length) {
              // Up wraps the first row directly to custom; other selections move down one at a time.
              if (selected === 0)
                await step(
                  "tui-navigation",
                  "\x1b[A",
                  () =>
                    state.interaction?.input?.selected ===
                    interaction.choices.length,
                );
              else
                for (
                  let index = selected;
                  index < interaction.choices.length;
                  index++
                )
                  await step(
                    "tui-navigation",
                    "\x1b[B",
                    () => state.interaction?.input?.selected === index + 1,
                  );
            }
            if (state.interaction?.input?.text !== "")
              throw new SdkError(
                "input-uncertain",
                "Custom composer already contains text; it will not be overwritten.",
              );
            let accumulated = "",
              chunk = "";
            const chunks: string[] = [];
            for (const { segment } of new Intl.Segmenter(undefined, {
              granularity: "grapheme",
            }).segment(request.answer)) {
              if (Buffer.byteLength(chunk + segment) > 64) {
                chunks.push(chunk);
                chunk = "";
              }
              chunk += segment;
            }
            if (chunk) chunks.push(chunk);
            for (const part of chunks) {
              accumulated += part;
              await step(
                "tui-text",
                part,
                () =>
                  state.interaction?.input?.selected ===
                    interaction.choices.length &&
                  state.interaction.input.text === accumulated,
              );
            }
            await step(
              "tui-submit",
              "\r",
              () =>
                reducer.toolResult(interaction.toolId!)?.digest ===
                createHash("sha256").update(request.answer).digest("hex"),
            );
          } else {
            writeAttempted = true;
            const accepted = await helper({
              ...envelope,
              modalHash,
              inputType: custom ? "readline-text" : undefined,
              dataBase64: Buffer.from(
                custom ? request.answer + "\r" : bytes,
              ).toString("base64"),
            });
            if (accepted.state === "rejected")
              throw new SdkError(
                "input-rejected",
                accepted.reason ?? "Remote input was rejected before write.",
              );
          }
          const deadline = Date.now() + (config.responseTimeoutMs ?? 30000);
          while (Date.now() < deadline) {
            await refresh();
            const result = reducer.toolResult(interaction.toolId!);
            const current = state.interaction;
            const written = remoteRequests.some(
              (r) => r.requestId === request.requestId && r.state === "written",
            );
            const rejected = remoteRequests.find(
              (r) =>
                r.requestId === request.requestId && r.state === "rejected",
            );
            if (rejected)
              throw new SdkError(
                "input-rejected",
                rejected.reason ?? "Remote input was rejected before write.",
              );
            const delivered =
              interaction.kind === "approval"
                ? (request.answer === "Deny"
                    ? result?.rejected
                    : !!result && !result.rejected) ||
                  (request.answer === "Approve" &&
                    current?.kind === "question" &&
                    current.toolId === interaction.toolId &&
                    current.id !== interaction.id)
                : interaction.kind === "question"
                  ? result?.digest ===
                    createHash("sha256").update(request.answer).digest("hex")
                  : written &&
                    ((processEvidence?.identityConfirmed &&
                      !processEvidence.alive &&
                      processEvidence.exitCode !== null) ||
                      (current?.kind === "approval" &&
                        current.id !== interaction.id));
            if (delivered) {
              reducer.setResponse({ ...base, state: "delivered" });
              state = {
                ...reducer.snapshot(),
                mode: "live",
                connection: state.connection,
              };
              return structuredClone(state.response!);
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          reducer.setResponse({ ...base, state: "delivery-unknown" });
          state = {
            ...reducer.snapshot(),
            mode: "live",
            connection: state.connection,
          };
          return structuredClone(state.response!);
        } catch (error) {
          if (
            error instanceof SdkError &&
            [
              "ssh-failed",
              "ssh-timeout",
              "ssh-unavailable",
              "invalid-remote-response",
            ].includes(error.code)
          )
            state.connection = closed ? "closed" : "disconnected";
          if (sent) {
            reducer.setResponse({
              requestId: request.requestId,
              sessionId: request.sessionId,
              executionId: request.executionId,
              interactionId: request.interactionId,
              revision: state.revision,
              state:
                (reservationSupported && !writeAttempted) ||
                (error instanceof SdkError && error.code === "input-rejected")
                  ? "not-submitted"
                  : "delivery-unknown",
            });
            state = {
              ...reducer.snapshot(),
              mode: "live",
              connection: state.connection,
            };
          }
          throw error;
        } finally {
          activeRequest = null;
        }
      })();
      requests.set(request.requestId, { binding, promise });
      return promise;
    },
    stop(request) {
      if (!managed || request.executionId !== managed.executionId)
        throw new SdkError(
          "wrong-stop-target",
          "Stop must target this client's managed execution.",
        );
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId))
        throw new SdkError(
          "invalid-stop-request",
          "A bounded stop request identity is required.",
        );
      if (stopPromise) {
        if (stopRequestId !== request.requestId)
          throw new SdkError(
            "stop-already-requested",
            "A stop request is already selected for this execution.",
          );
        return stopPromise;
      }
      if (state.connection !== "connected")
        throw new SdkError("not-connected", "Connect before stopping.");
      if (["completed", "stopped", "failed"].includes(state.execution))
        throw new SdkError(
          "execution-not-running",
          "This execution is already terminal; stop does not start another run.",
        );
      stopRequestId = request.requestId;
      reducer.setContext({
        execution: "unknown",
        stop: {
          ...request,
          state: "stopping",
          childrenVerified: false,
          trackedCount: 0,
          remaining: [],
          reason: null,
          observedAt: new Date().toISOString(),
        },
      });
      stopPromise = (async () => {
        try {
          const result: StopResult = await helper({
            action: "stop",
            root: managed!.remoteRoot,
            ...request,
          });
          if (
            result.executionId !== request.executionId ||
            result.requestId !== request.requestId
          )
            throw new SdkError(
              "stop-identity-mismatch",
              "The stop receipt does not match this request.",
            );
          reducer.setContext({ stop: result, execution: "unknown" });
          await refresh();
          return structuredClone(result);
        } catch (error) {
          reducer.setContext({
            execution: "unknown",
            stop: {
              ...request,
              state: "unknown",
              childrenVerified: false,
              trackedCount: 0,
              remaining: [],
              reason: error instanceof SdkError ? error.code : "stop-failed",
              observedAt: new Date().toISOString(),
            },
          });
          throw error;
        }
      })();
      return stopPromise;
    },
    close() {
      closed = true;
      generation++;
      for (const process of processes) process.kill();
      processes.clear();
      state.connection = "closed";
      listeners.clear();
      reducer.close();
    },
  };
}
const PREFLIGHT = String.raw`
import os,sys,json,platform,shutil,subprocess,hashlib,pty,signal
if sys.version_info<(3,9):
    print(json.dumps(dict(error='python-version-unsupported',message='Python 3.9 or newer is required.')))
    sys.exit(0)
request=json.load(sys.stdin)
path=request.get('cliPath') or shutil.which('cline')
discovery='explicit' if request.get('cliPath') else 'noninteractive-path'
if not path:
    try:
        login=subprocess.run(['bash','-lic','printf "\\nCLINE_SDK_PATH=%s\\n" "$(command -v cline)"'],capture_output=True,text=True,timeout=10)
        matches=[line[len('CLINE_SDK_PATH='):] for line in login.stdout.splitlines() if line.startswith('CLINE_SDK_PATH=')]
        path=matches[-1] if matches and matches[-1] else None
        discovery='login-shell' if path else 'not-installed' if login.returncode==0 else 'login-shell-failed'
    except (OSError,subprocess.TimeoutExpired): discovery='login-shell-failed'
version=None
digest=None
if path and os.path.isfile(path) and os.access(path,os.X_OK):
    try:
        result=subprocess.run([path,'--version'],capture_output=True,text=True,timeout=15,env={**os.environ,'CLINE_NO_AUTO_UPDATE':'1'})
        if result.returncode==0: version=result.stdout.strip()
        h=hashlib.sha256()
        with open(path,'rb') as source:
            for chunk in iter(lambda:source.read(1024*1024),b''):h.update(chunk)
        digest=h.hexdigest()
    except (OSError,subprocess.TimeoutExpired): pass
working_pty=False
try:
    a,b=pty.openpty();os.close(a);os.close(b);working_pty=True
except OSError: pass
tmux=shutil.which('tmux')
working_ownership=False
try:
    if hasattr(signal,'pidfd_send_signal'):
        fd=os.pidfd_open(os.getpid());os.close(fd);working_ownership=True
except (AttributeError,OSError): pass
print(json.dumps(dict(platform=platform.system(),pythonVersion=platform.python_version(),pty=working_pty,processOwnership=working_ownership,tmux=subprocess.check_output([tmux,'-V'],text=True).strip() if tmux else None,cliPath=path,cliVersion=version,cliHash=digest,discovery=discovery,bootId=open('/proc/sys/kernel/random/boot_id').read().strip() if platform.system()=='Linux' else '')))
`;
