import xterm from "@xterm/headless";
export interface Message {
  id: string;
  role: "assistant" | "user";
  text: string;
}
export interface HistoryObservation {
  kind: "history";
  seq: number;
  observedAt: string;
  dataBase64: string;
  elapsedNs?: string;
}
export interface PtyObservation {
  kind: "pty";
  seq: number;
  observedAt: string;
  dataBase64: string;
  elapsedNs?: string;
}
export interface ProcessObservation {
  kind: "process";
  seq: number;
  observedAt: string;
  identity: { pid: number; startTime: string; bootId: string } | null;
  alive: boolean;
  identityConfirmed: boolean;
  exitCode: number | null;
  manifestStatus: string | null;
}
export type Observation =
  | HistoryObservation
  | PtyObservation
  | ProcessObservation;
export interface Recording {
  schemaVersion: 1;
  cli: { name: string; version: string; profile: string };
  terminal: { rows: number; cols: number };
  sessionId: string;
  executionId: string;
  observations: Observation[];
  provenance: {
    source: string;
    sourceSha256: string;
    review: string;
    transformations: string[];
    complete: boolean;
    truncated: boolean;
  };
}
export type ConnectionState =
  | "replay"
  | "closed"
  | "connecting"
  | "connected"
  | "disconnected";
export type ExecutionState =
  | "unknown"
  | "running"
  | "awaiting-input"
  | "completed"
  | "stopped"
  | "failed";
export type InteractionState =
  | "awaiting-response"
  | "submitting"
  | "delivered"
  | "delivery-unknown"
  | "unsupported";
export interface Interaction {
  id: string;
  revision: number;
  kind: "question" | "unsupported";
  state: InteractionState;
  prompt: string;
  choices: string[];
}
export interface Snapshot {
  mode: "replay" | "live";
  sessionId: string | null;
  executionId: string | null;
  revision: number;
  connection: ConnectionState;
  execution: ExecutionState;
  messages: Message[];
  interaction: Interaction | null;
  replay: {
    position: number;
    total: number;
    complete: boolean;
    truncated: boolean;
  };
}
export interface SdkEvent {
  type: "message.upsert" | "interaction.changed" | "state.changed";
  sessionId: string | null;
  executionId: string | null;
  interactionId: string | null;
  requestId: string | null;
  revision: number;
  observationSeq: number;
  observedAt: string;
  payload: unknown;
}
export interface ResponseRequest {
  sessionId: string;
  executionId: string;
  interactionId: string;
  revision: number;
  requestId: string;
  answer: string;
}
export class SdkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SdkError";
  }
}
export interface Client {
  openReplay(recording: Recording): Promise<Snapshot>;
  nextObservation(): Promise<Snapshot>;
  replayAll(): Promise<Snapshot>;
  snapshot(): Snapshot;
  subscribe(listener: (event: SdkEvent) => void): () => void;
  respond(request: ResponseRequest): Promise<never>;
  capabilities(): {
    replay: true;
    live: false;
    responses: false;
    companyCompatibility: "unverified";
  };
  close(): void;
}
interface Reducer extends Client {
  ingest(observation: Observation): Promise<Snapshot>;
  setContext(
    context: Partial<
      Pick<
        Snapshot,
        | "sessionId"
        | "executionId"
        | "connection"
        | "mode"
        | "execution"
        | "interaction"
      >
    >,
  ): Snapshot;
}
function validateRecording(input: Recording): void {
  const invalid = () => {
    throw new SdkError(
      "invalid-recording",
      "Expected schema 1, bounded terminal geometry, and ordered raw observations.",
    );
  };
  if (
    input?.schemaVersion !== 1 ||
    !input.sessionId ||
    !input.executionId ||
    !input.cli?.profile ||
    !input.provenance ||
    !Array.isArray(input.observations) ||
    !Number.isInteger(input.terminal?.cols) ||
    !Number.isInteger(input.terminal?.rows) ||
    input.terminal.cols < 20 ||
    input.terminal.cols > 500 ||
    input.terminal.rows < 5 ||
    input.terminal.rows > 200
  )
    invalid();
  let last = -1;
  for (const obs of input.observations) {
    if (
      !Number.isSafeInteger(obs.seq) ||
      obs.seq <= last ||
      !Number.isFinite(Date.parse(obs.observedAt)) ||
      !["pty", "history", "process"].includes(obs.kind) ||
      (obs.kind !== "process" &&
        (typeof obs.dataBase64 !== "string" ||
          !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            obs.dataBase64,
          )))
    )
      invalid();
    last = obs.seq;
  }
}
export function createReducer(options: { mode: "replay" }): Reducer {
  if (options.mode !== "replay")
    throw new SdkError("unsupported-mode", "Only replay is available.");
  let state: Snapshot = {
    mode: "replay",
    sessionId: null,
    executionId: null,
    revision: 0,
    connection: "closed",
    execution: "unknown",
    messages: [],
    interaction: null,
    replay: { position: 0, total: 0, complete: false, truncated: false },
  };
  let recording: Recording | null = null;
  let terminal: import("@xterm/headless").Terminal | null = null;
  let interactionSerial = 0;
  const listeners = new Set<(event: SdkEvent) => void>();
  const snapshot = () => structuredClone(state);
  const emit = (type: SdkEvent["type"], obs: Observation, payload: unknown) => {
    state.revision++;
    for (const listener of listeners)
      listener(
        structuredClone({
          type,
          sessionId: state.sessionId,
          executionId: state.executionId,
          interactionId: state.interaction?.id ?? null,
          requestId: null,
          revision: state.revision,
          observationSeq: obs.seq,
          observedAt: obs.observedAt,
          payload,
        }),
      );
  };
  const interpretScreen = (obs: Observation) => {
    const lines = [];
    const buffer = terminal!.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    for (let row = 0; row <= cursorRow; row++)
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    const screen = lines.join("\n");
    const current = lines.at(-1) ?? "";
    const previous = lines.at(-2) ?? "";
    const questionComplete = /^Choose 1-\d+ or type a custom answer:$/.test(
      previous.trim(),
    );
    const verified =
      recording!.cli.name === "cline" &&
      recording!.cli.version === "3.0.69" &&
      recording!.cli.profile === "cline-3.0.69-readline";
    const unsupported =
      (!verified && screen.trim()) ||
      current.includes("[y/N]") ||
      (!questionComplete && /^>\s*$/.test(current));
    if (unsupported) {
      const prompt = !verified
        ? "CLI profile is not verified."
        : current.includes("[y/N]")
          ? "Approval input is not supported by this replay baseline."
          : "Input prompt syntax is not verified.";
      if (
        state.interaction?.kind === "unsupported" &&
        state.interaction.prompt === prompt
      )
        return;
      state.interaction = {
        id: `${state.executionId}:interaction:${++interactionSerial}`,
        revision: state.revision + 1,
        kind: "unsupported",
        state: "unsupported",
        prompt,
        choices: [],
      };
      state.execution = "unknown";
      emit("interaction.changed", obs, state.interaction);
      return;
    }
    if (!questionComplete) {
      if (state.interaction) {
        state.interaction = null;
        state.execution = "unknown";
        emit("interaction.changed", obs, null);
      }
      return;
    }
    const start = screen.lastIndexOf("[follow-up]");
    if (start < 0) return;
    const block = screen.slice(start);
    if (!/Choose 1-\d+ or type a custom answer:/.test(block)) return;
    const prompt = block.split("\n")[0].slice("[follow-up]".length).trim();
    const choices = [
      ...block
        .slice(0, block.indexOf("Choose 1-"))
        .matchAll(/^\s+\d+\.\s+(.+)$/gm),
    ].map((match) => match[1].trim());
    if (!choices.length) return;
    if (
      state.interaction?.prompt === prompt &&
      JSON.stringify(state.interaction.choices) === JSON.stringify(choices)
    )
      return;
    state.interaction = {
      id: `${state.executionId}:interaction:${++interactionSerial}`,
      revision: state.revision + 1,
      kind: "question",
      state: "awaiting-response",
      prompt,
      choices,
    };
    state.execution = "awaiting-input";
    emit("interaction.changed", obs, state.interaction);
  };
  return {
    async openReplay(input) {
      validateRecording(input);
      recording = structuredClone(input);
      terminal?.dispose();
      terminal = new xterm.Terminal({
        ...input.terminal,
        allowProposedApi: true,
        scrollback: 1000,
      });
      interactionSerial = 0;
      state = {
        ...state,
        sessionId: input.sessionId,
        executionId: input.executionId,
        revision: 0,
        connection: "replay",
        execution: "unknown",
        messages: [],
        interaction: null,
        replay: {
          position: 0,
          total: input.observations.length,
          complete: input.provenance.complete,
          truncated: input.provenance.truncated,
        },
      };
      return snapshot();
    },
    async nextObservation() {
      if (!recording)
        throw new SdkError("replay-not-open", "Open a recording first.");
      const obs = recording.observations[state.replay.position];
      if (!obs) return snapshot();
      state.replay.position++;
      if (obs.kind === "pty") {
        await new Promise<void>((resolve) =>
          terminal!.write(Buffer.from(obs.dataBase64, "base64"), resolve),
        );
        interpretScreen(obs);
      }
      if (obs.kind === "history") {
        let messages: Message[];
        try {
          const doc = JSON.parse(
            Buffer.from(obs.dataBase64, "base64").toString("utf8"),
          );
          if (
            doc.version !== 1 ||
            doc.sessionId !== state.sessionId ||
            !Array.isArray(doc.messages)
          )
            throw new Error("Invalid envelope");
          messages = doc.messages
            .filter(
              (raw: { role: string }) =>
                raw.role === "assistant" || raw.role === "user",
            )
            .map(
              (raw: {
                id: string;
                role: Message["role"];
                content: { type: string; text: string }[];
              }) => {
                if (
                  typeof raw.id !== "string" ||
                  !Array.isArray(raw.content) ||
                  raw.content.some(
                    (part) =>
                      part.type === "text" && typeof part.text !== "string",
                  )
                )
                  throw new Error("Invalid message");
                return {
                  id: raw.id,
                  role: raw.role,
                  text: raw.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n"),
                };
              },
            );
        } catch {
          throw new SdkError(
            "invalid-history",
            "History observation was incomplete or incompatible; the last valid conversation is preserved.",
          );
        }
        for (const message of messages) {
          if (!message.text) continue;
          const old = state.messages.find((m) => m.id === message.id);
          if (!old || old.text !== message.text || old.role !== message.role) {
            if (old) Object.assign(old, message);
            else state.messages.push({ ...message });
            emit("message.upsert", obs, message);
          }
        }
      }
      if (obs.kind === "process") {
        const previous = state.execution;
        if (!obs.identityConfirmed) state.execution = "unknown";
        else if (obs.alive)
          state.execution =
            state.interaction?.state === "awaiting-response"
              ? "awaiting-input"
              : state.interaction?.state === "unsupported"
                ? "unknown"
                : "running";
        else if (obs.exitCode === null) state.execution = "unknown";
        else if (obs.manifestStatus === "cancelled")
          state.execution = "stopped";
        else if (obs.exitCode !== 0 || obs.manifestStatus === "failed")
          state.execution = "failed";
        else if (
          obs.manifestStatus === "completed" &&
          state.messages.some((m) => m.role === "assistant" && m.text)
        )
          state.execution = "completed";
        else state.execution = "unknown";
        if (!obs.alive && obs.exitCode !== null) state.interaction = null;
        if (previous !== state.execution)
          emit("state.changed", obs, {
            execution: state.execution,
            process: obs,
          });
      }
      return snapshot();
    },
    async ingest(obs) {
      if (!recording)
        throw new SdkError(
          "reducer-not-open",
          "Initialize the observation profile first.",
        );
      recording.observations = [obs];
      state.replay.position = 0;
      try {
        return await this.nextObservation();
      } finally {
        recording.observations = [];
      }
    },
    setContext(context) {
      if (
        Object.entries(context).some(
          ([key, value]) =>
            JSON.stringify(state[key as keyof Snapshot]) !==
            JSON.stringify(value),
        )
      ) {
        Object.assign(state, context);
        emit(
          "state.changed",
          {
            kind: "pty",
            seq: 0,
            observedAt: new Date().toISOString(),
            dataBase64: "",
          },
          context,
        );
      }
      return snapshot();
    },
    async replayAll() {
      while (recording && state.replay.position < recording.observations.length)
        await this.nextObservation();
      return snapshot();
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async respond() {
      throw new SdkError(
        "replay-read-only",
        "Replay never sends remote input.",
      );
    },
    capabilities() {
      return {
        replay: true,
        live: false,
        responses: false,
        companyCompatibility: "unverified",
      };
    },
    close() {
      state.connection = "closed";
      terminal?.dispose();
      terminal = null;
      recording = null;
      listeners.clear();
    },
  };
}
