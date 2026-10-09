import { createReducer, type Client } from "./reducer.js";
import { createLiveClient, type LiveClient, type LiveOptions } from "./live.js";
export { SdkError } from "./reducer.js";
export type {CliFeatures, FeatureCapability, DeclaredFeatures} from "./capabilities.js";
export { readDiagnostic, compareDiagnostic } from "./diagnostics.js";
export {
  reviewDiagnostic,
  inspectDiagnostic,
  previewDiagnosticExport,
  exportDiagnostic,
} from "./export.js";
export type {
  DiagnosticReview,
  DiagnosticContentPage,
  DiagnosticExportOptions,
} from "./export.js";
export type {
  DiagnosticOptions,
  DiagnosticStatus,
  DiagnosticBundle,
} from "./diagnostics.js";
export type {
  Client,
  Recording,
  Observation,
  Snapshot,
  Message,
  Interaction,
  ResponseRequest,
  ResponseResult,
  SdkEvent,
  ExecutionState,
  ConnectionState,
  StopRequest,
  StopResult,
} from "./reducer.js";
export type {
  LiveClient,
  LiveOptions,
  ConnectionOptions,
  PreflightReport,
  StartRequest,
  ResumeRequest,
  ManagedExecution,
} from "./live.js";
export function createClient(options: { mode: "replay" }): Client;
export function createClient(options: LiveOptions): LiveClient;
export function createClient(
  options: { mode: "replay" } | LiveOptions,
): Client | LiveClient {
  return options.mode === "live"
    ? createLiveClient(options)
    : createReducer({ mode: "replay" });
}
