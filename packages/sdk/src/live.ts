import type {CliFeatures, DeclaredFeatures} from './capabilities.js';
import type {TerminalSize} from './terminal-geometry.js';
import type {ResultFormat, ResultRequest} from './structured-result.js';
import type {DiagnosticOptions, DiagnosticStatus} from './diagnostics.js';
import type {Snapshot, SdkEvent, ResponseRequest, ResponseResult, StopRequest, StopResult} from './reducer.js';
import type {SendMessageRequest, MessageDelivery} from './message.js';
export {createLiveClient} from './direct-live.js';

export interface ConnectionOptions {
  /** Declarations never authorize an unknown executable or input protocol. */
  declaredFeatures?: DeclaredFeatures;
  host: string;
  cliPath?: string;
  /** Defaults to native. The retired isolated mode is rejected before SSH. */
  storageMode?: "isolated" | "native";
  sessionDirectory?: string;
  identityFile?: string;
  user?: string;
  port?: number;
  sshExecutable?: string;
  /** Legacy option: now a tmux namespace key only; no directory or files are created. */
  remoteRoot?: string;
  timeoutMs?: number;
  /** @deprecated Interactive input is disabled in direct SSH mode. */
  responseTimeoutMs?: number;
}
export interface LiveOptions {
  mode: "live";
  connection: ConnectionOptions;
}
export interface PreflightReport {
  storageMode: "isolated" | "native";
  sessionDirectory: string | null;
  help: { state: "success" | "exit-failed" | "timeout" | "execution-failed" | "unparseable" | "truncated" | "unavailable"; exitCode: number | null; channels: string[] };
  missingOptions: string[] | null;
  features: CliFeatures;
  platform: string;
  /** False means Python is unused, not that its installation was inspected. */
  python: boolean;
  pty: boolean;
  processOwnership?: boolean;
  tmux: string | null;
  cliPath: string | null;
  /** Always null: connecting never queries the CLI version. */
  cliVersion: string | null;
  cliFlags?: string[] | null;
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
  /** Initial PTY size; defaults to 120 columns by 40 rows. */
  terminal?: TerminalSize;
  resultFormat?:ResultFormat;
  outputMode?: "terminal" | "json";
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
  /** History entries are saved conversations, not process ownership claims. */
  kind?: "tmux" | "history";
  readOnly?: boolean;
  supersededBy?:string;
  resultRequest?:ResultRequest;
  outputMode?: "terminal" | "json";
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
  startDiagnostics(options: DiagnosticOptions): Promise<DiagnosticStatus>;
  stopDiagnostics(): Promise<DiagnosticStatus>;
  diagnostics(): DiagnosticStatus;
  preflight(): Promise<PreflightReport>;
  connect(): Promise<PreflightReport>;
  disconnect(): void;
  listManagedExecutions(): Promise<ManagedExecution[]>;
  attach(executionId: string): Promise<Snapshot>;
  reconfirmDelivery(): Promise<Snapshot>;
  start(request: StartRequest): Promise<Snapshot>;
  resume(request: ResumeRequest): Promise<Snapshot>;
  sendMessage(request: SendMessageRequest): Promise<MessageDelivery>;
  refresh(): Promise<Snapshot>;
  snapshot(): Snapshot;
  subscribe(listener: (event: SdkEvent) => void): () => void;
  capabilities(): {
    structuredResults:{json:boolean;schemaValidation:boolean;nativeSchema:false};
    features: CliFeatures;
    outputModes: {terminal: boolean; json: boolean};
    stop: boolean;
    transport: "ssh-tmux";
    limitation: string;
    replay: false;
    live: true;
    responses: boolean;
    freeText: boolean;
    resume: boolean;
    sendMessage: boolean;
    companyCompatibility: "unverified";
  };
  respond(request: ResponseRequest): Promise<ResponseResult>;
  stop(request: StopRequest): Promise<StopResult>;
  close(): void;
}
