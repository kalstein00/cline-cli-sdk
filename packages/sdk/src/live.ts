import childProcess from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createReducer,
  SdkError,
  type Snapshot,
  type SdkEvent,
  type ResponseRequest,
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
}
export interface LiveOptions {
  mode: "live";
  connection: ConnectionOptions;
}
export interface PreflightReport {
  platform: string;
  python: boolean;
  pty: boolean;
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
  cwd: string;
  prompt: string;
  dataDir?: string;
}
export interface ManagedExecution {
  executionId: string;
  remoteRoot: string;
  sessionId: string | null;
}
export interface LiveClient {
  preflight(): Promise<PreflightReport>;
  connect(): Promise<PreflightReport>;
  start(request: StartRequest): Promise<Snapshot>;
  refresh(): Promise<Snapshot>;
  snapshot(): Snapshot;
  subscribe(listener: (event: SdkEvent) => void): () => void;
  capabilities(): {
    replay: false;
    live: true;
    responses: false;
    companyCompatibility: "unverified";
  };
  respond(request: ResponseRequest): Promise<never>;
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
  const reducer = createReducer({ mode: "replay" });
  let state: Snapshot = { ...reducer.snapshot(), mode: "live" };
  let report: PreflightReport | null = null;
  let managed: ManagedExecution | null = null;
  let cursor = 0;
  let sequence = 0;
  let historyHash: string | null = null;
  let refreshing: Promise<Snapshot> | null = null;
  let observationGap = false;
  let closed = false;
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
    const source = await readFile(
      new URL("../remote/supervisor.py", import.meta.url),
    );
    return execute(
      `import base64,io,json,sys;request=json.load(sys.stdin);sys.stdin=io.StringIO(json.dumps(request));exec(base64.b64decode(request['sourceBase64']))`,
      { sourceBase64: source.toString("base64"), ...(input as object) },
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
      for (const raw of result.observations ?? [])
        await reducer.ingest({ ...raw, seq: ++sequence });
      cursor = result.cursor;
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
      if (result.process)
        await reducer.ingest({
          ...result.process,
          seq: ++sequence,
          observedAt: new Date().toISOString(),
        });
      observationGap ||= !!result.gap;
      if (
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
  return {
    preflight,
    async connect() {
      state.connection = "connecting";
      try {
        const found = await preflight();
        state.connection = "connected";
        return found;
      } catch (error) {
        state.connection = "disconnected";
        throw error;
      }
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
        !request.cwd.startsWith("/") ||
        !request.prompt.trim() ||
        request.prompt.length > 100000
      )
        throw new SdkError(
          "invalid-task",
          "An absolute remote directory and bounded text prompt are required.",
        );
      const executionId = "run-" + randomUUID();
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
          profile: "cline-3.0.69-readline",
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
    refresh,
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    capabilities() {
      return {
        replay: false,
        live: true,
        responses: false,
        companyCompatibility: "unverified",
      };
    },
    async respond() {
      throw new SdkError(
        "responses-unavailable",
        "Live response support is not available.",
      );
    },
    close() {
      closed = true;
      for (const process of processes) process.kill();
      processes.clear();
      state.connection = "closed";
      listeners.clear();
      reducer.close();
    },
  };
}
const PREFLIGHT = String.raw`
import os,sys,json,platform,shutil,subprocess,hashlib,pty
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
print(json.dumps(dict(platform=platform.system(),pythonVersion=platform.python_version(),pty=working_pty,tmux=subprocess.check_output([tmux,'-V'],text=True).strip() if tmux else None,cliPath=path,cliVersion=version,cliHash=digest,discovery=discovery,bootId=open('/proc/sys/kernel/random/boot_id').read().strip() if platform.system()=='Linux' else '')))
`;
