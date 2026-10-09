import xterm from "@xterm/headless";
import unicode11 from "@xterm/addon-unicode11";
import { createHash } from "node:crypto";
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
  requestedStop?: boolean;
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
  kind: "question" | "approval" | "recovery" | "unsupported";
  state: InteractionState;
  prompt: string;
  choices: string[];
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  responseKinds?: ("choice" | "approval" | "text")[];
  /** Observed input destination, never a terminal-input escape hatch. */
  input?: { mode: "tui"; selected: number | null; text: string | null };
}
export interface ResponseResult {
  requestId: string;
  sessionId: string;
  executionId: string;
  interactionId: string;
  state: "submitting" | "delivered" | "delivery-unknown" | "not-submitted";
  revision: number;
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
  response: ResponseResult | null;
  replay: {
    position: number;
    total: number;
    complete: boolean;
    truncated: boolean;
  };
}
export interface SdkEvent {
  type:
    | "message.upsert"
    | "interaction.changed"
    | "state.changed"
    | "response.changed";
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
  setResponse(response: ResponseResult): Snapshot;
  toolResult(id: string): { digest: string; rejected: boolean } | undefined;
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
    response: null,
    replay: { position: 0, total: 0, complete: false, truncated: false },
  };
  let recording: Recording | null = null;
  let terminal: import("@xterm/headless").Terminal | null = null;
  let interactionSerial = 0;
  let pendingTools: { id: string; name: string; input: any }[] = [];
  let results = new Map<string, { digest: string; rejected: boolean }>();
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
          interactionId:
            type === "response.changed"
              ? (state.response?.interactionId ?? null)
              : (state.interaction?.id ?? null),
          requestId:
            type === "response.changed"
              ? (state.response?.requestId ?? null)
              : null,
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
    if (
      recording!.cli.profile === "cline-3.0.69-tui" &&
      recording!.cli.name === "cline" &&
      recording!.cli.version === "3.0.69"
    ) {
      const visible = Array.from(
        { length: recording!.terminal.rows },
        (_, row) =>
          buffer
            .getLine(buffer.baseY + row)
            ?.translateToString(true)
            .trimEnd() ?? "",
      );
      const permission = visible
        .map((line) => line.trim())
        .lastIndexOf("Cline needs permission");
      const popup = visible.some((line) =>
        line.includes("Press Enter to open, any other key to close"),
      );
      if (permission >= 0 && !popup) {
        const body = visible.slice(permission + 1);
        const nonempty = body.map((line) => line.trim()).filter(Boolean);
        const matches = pendingTools.filter(
          (tool) =>
            tool.name === "run_commands" &&
            nonempty[0] === "Approve tool call?" &&
            nonempty[1] === tool.name &&
            Array.isArray(tool.input?.commands) &&
            tool.input.commands.length > 0 &&
            tool.input.commands.every(
              (command: unknown) => typeof command === "string",
            ) &&
            JSON.stringify(nonempty.filter((line) => line.startsWith("$ "))) ===
              JSON.stringify(
                tool.input.commands.map((command: string) => `$ ${command}`),
              ) &&
            body.some(
              (line) =>
                line.includes("[y] Approve") && line.includes("[n] Deny"),
            ),
        );
        if (matches.length === 1) {
          const tool = matches[0];
          if (
            state.interaction?.kind === "approval" &&
            state.interaction.toolId === tool.id
          )
            return;
          state.interaction = {
            id: `${state.executionId}:interaction:${++interactionSerial}`,
            revision: state.revision + 1,
            kind: "approval",
            state: "awaiting-response",
            prompt: `Approve ${tool.name}?`,
            choices: ["Approve", "Deny"],
            toolId: tool.id,
            toolName: tool.name,
            toolInput: structuredClone(tool.input),
            responseKinds: ["approval"],
          };
          state.execution = "awaiting-input";
          emit("interaction.changed", obs, state.interaction);
          return;
        }
      }
      if (popup || permission >= 0) {
        const prompt = popup
          ? "An additional TUI dialog owns input."
          : "Current TUI approval is not uniquely linked to complete visible tool arguments.";
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
      const title = visible
        .map((line) => line.trim())
        .lastIndexOf("Cline is asking a question");
      if (title >= 0) {
        const body = visible.slice(title + 1);
        const rows = body
          .map((line, index) => ({ text: line.trim(), index }))
          .filter((row) => row.text);
        const matches = pendingTools.filter(
          (tool) =>
            tool.name === "ask_question" &&
            typeof tool.input?.question === "string" &&
            Array.isArray(tool.input?.options) &&
            rows[0]?.text === tool.input.question &&
            tool.input.options.every(
              (option: unknown, index: number) =>
                typeof option === "string" &&
                (rows[index + 1]?.text === option ||
                  rows[index + 1]?.text === `> ${option}`),
            ),
        );
        const tool = matches.length === 1 ? matches[0] : undefined;
        if (
          tool &&
          tool.input.options.length <= 9 &&
          new Set(tool.input.options).size === tool.input.options.length
        ) {
          const choices: string[] = tool.input.options;
          const last = rows[choices.length].index;
          const custom = body.slice(last + 1);
          const customRow = custom.findIndex((line) => /^\s*> /.test(line));
          const selected =
            customRow >= 0
              ? choices.length
              : choices.findIndex(
                  (option, index) => rows[index + 1]?.text === `> ${option}`,
                );
          let text: string | null = null;
          if (customRow >= 0) {
            const prefix = custom[customRow].match(/^\s*> /)![0];
            const first = custom[customRow].slice(prefix.length);
            if (
              first === "Type a response..." ||
              first === "Type a response first..."
            )
              text = "";
            else {
              const parts = [first];
              for (const line of custom.slice(customRow + 1)) {
                if (!line.trim()) break;
                parts.push(line.slice(prefix.length));
                if (line.trimEnd().endsWith("|")) break;
              }
              const joined = parts.join("");
              if (joined.endsWith("|")) text = joined.slice(0, -1);
            }
          }
          const input = {
            mode: "tui" as const,
            selected: selected < 0 ? null : selected,
            text,
          };
          if (
            state.interaction?.kind === "question" &&
            state.interaction.toolId === tool.id
          ) {
            state.interaction.input = input;
            return;
          }
          state.interaction = {
            id: `${state.executionId}:interaction:${++interactionSerial}`,
            revision: state.revision + 1,
            kind: "question",
            state: "awaiting-response",
            prompt: tool.input.question,
            choices,
            toolId: tool.id,
            toolName: tool.name,
            responseKinds: ["choice", "text"],
            input,
          };
          state.execution = "awaiting-input";
          emit("interaction.changed", obs, state.interaction);
          return;
        }
        const prompt =
          "Current TUI question is not uniquely linked to history.";
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
      if (state.interaction) {
        state.interaction = null;
        state.execution = "unknown";
        emit("interaction.changed", obs, null);
      }
      return;
    }
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
    const approval = current
      .trim()
      .match(/^Approve "(ask_question|run_commands)" (.+) \[y\/N\]$/);
    let approvedTool: (typeof pendingTools)[number] | undefined;
    if (approval) {
      try {
        const input = JSON.parse(approval[2]);
        const matches = pendingTools.filter(
          (tool) =>
            tool.name === approval[1] &&
            JSON.stringify(tool.input) === JSON.stringify(input),
        );
        if (matches.length === 1) approvedTool = matches[0];
      } catch {
        const prefix = approval[2].replace(/\.\.\.$/, "").trimEnd();
        if (approval[2].endsWith("...") && prefix.length >= 32) {
          const matches = pendingTools.filter(
            (tool) =>
              tool.name === approval[1] &&
              JSON.stringify(tool.input).startsWith(prefix),
          );
          if (matches.length === 1) approvedTool = matches[0];
        }
      }
    }
    const unsupported =
      (!verified && screen.trim()) ||
      (current.includes("[y/N]") && !approvedTool) ||
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
    if (verified && approvedTool) {
      if (
        state.interaction?.kind === "approval" &&
        state.interaction.toolId === approvedTool.id
      )
        return;
      state.interaction = {
        id: `${state.executionId}:interaction:${++interactionSerial}`,
        revision: state.revision + 1,
        kind: "approval",
        state: "awaiting-response",
        prompt: `Approve ${approvedTool.name}?`,
        choices: ["Approve", "Deny"],
        toolId: approvedTool.id,
        toolName: approvedTool.name,
        toolInput: structuredClone(approvedTool.input),
        responseKinds: ["approval"],
      };
      state.execution = "awaiting-input";
      emit("interaction.changed", obs, state.interaction);
      return;
    }
    if (!questionComplete) {
      // This verified readline CLI can print the last assistant line after opening
      // recovery. Its unanswered prompt remains active while the cursor advances
      // exactly one row; this is not permission to rediscover a scrollback menu.
      const lateRecoveryOutput =
        state.interaction?.kind === "recovery" &&
        (state.response?.interactionId !== state.interaction.id ||
          state.response?.state === "not-submitted") &&
        current.trim() === "" &&
        previous.trim() !== "" &&
        /^Choose 1-2 or type a custom answer:$/.test(
          (lines.at(-3) ?? "").trim(),
        );
      if (lateRecoveryOutput) return;
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
    const prompt = block
      .slice(0, block.indexOf("Choose 1-"))
      .replace(/^\[follow-up\]\s*/, "")
      .replace(/^\s+\d+\.\s+.+$/gm, "")
      .trim();
    const choices = [
      ...block
        .slice(0, block.indexOf("Choose 1-"))
        .matchAll(/^\s+\d+\.\s+(.+)$/gm),
    ].map((match) => match[1].trim());
    if (!choices.length) return;
    const firstLine = block.split("\n")[0].slice("[follow-up]".length).trim();
    const recovery =
      /^mistake_limit_reached \(\d+\/\d+\)$/.test(firstLine) &&
      prompt.includes("How should Cline continue?") &&
      JSON.stringify(choices) ===
        JSON.stringify(["Try a different approach", "Stop this run"]);
    const matches = pendingTools.filter(
      (tool) =>
        tool.name === "ask_question" &&
        tool.input?.question === firstLine &&
        JSON.stringify(tool.input?.options) === JSON.stringify(choices),
    );
    const tool = matches.length === 1 ? matches[0] : undefined;
    const rejectedId = recovery
      ? [...results.entries()]
          .filter(([, result]) => result.rejected)
          .at(-1)?.[0]
      : undefined;
    if (
      state.mode === "live" &&
      ((!tool && !rejectedId) ||
        choices.length > 9 ||
        new Set(choices).size !== choices.length)
    ) {
      const unresolved = `${firstLine}\nSafe response target is not uniquely linked to current history.`;
      if (
        state.interaction?.kind === "unsupported" &&
        state.interaction.prompt === unresolved
      )
        return;
      state.interaction = {
        id: `${state.executionId}:interaction:${++interactionSerial}`,
        revision: state.revision + 1,
        kind: "unsupported",
        state: "unsupported",
        prompt: unresolved,
        choices: [],
        responseKinds: [],
      };
      state.execution = "unknown";
      emit("interaction.changed", obs, state.interaction);
      return;
    }
    if (
      state.interaction?.prompt === (recovery ? prompt : firstLine) &&
      state.interaction?.toolId === (tool?.id ?? rejectedId) &&
      JSON.stringify(state.interaction.choices) === JSON.stringify(choices)
    )
      return;
    state.interaction = {
      id: `${state.executionId}:interaction:${++interactionSerial}`,
      revision: state.revision + 1,
      kind: "question",
      state: "awaiting-response",
      prompt: recovery ? prompt : firstLine,
      choices,
      responseKinds:
        (tool || rejectedId) &&
        choices.length <= 9 &&
        new Set(choices).size === choices.length
          ? recovery
            ? ["choice"]
            : ["choice", "text"]
          : [],
      ...(tool ? { toolId: tool.id, toolName: tool.name } : {}),
      ...(recovery ? { kind: "recovery" as const, toolId: rejectedId } : {}),
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
      terminal.loadAddon(new unicode11.Unicode11Addon());
      terminal.unicode.activeVersion = "11";
      interactionSerial = 0;
      pendingTools = [];
      results = new Map();
      state = {
        ...state,
        sessionId: input.sessionId,
        executionId: input.executionId,
        revision: 0,
        connection: "replay",
        execution: "unknown",
        messages: [],
        interaction: null,
        response: null,
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
        let nextTools: typeof pendingTools = [];
        const nextResults = new Map<
          string,
          { digest: string; rejected: boolean }
        >();
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
          for (const raw of doc.messages) {
            if (!Array.isArray(raw.content)) throw new Error("Invalid content");
            for (const part of raw.content) {
              if (
                part.type === "tool_use" &&
                typeof part.id === "string" &&
                typeof part.name === "string"
              )
                nextTools.push({
                  id: part.id,
                  name: part.name,
                  input: part.input,
                });
              if (
                part.type === "tool_result" &&
                typeof part.tool_use_id === "string"
              )
                nextResults.set(part.tool_use_id, {
                  digest: createHash("sha256")
                    .update(
                      typeof part.content === "string"
                        ? part.content
                        : JSON.stringify(part.content),
                    )
                    .digest("hex"),
                  rejected:
                    part.is_error === true ||
                    JSON.stringify(part.content).includes(
                      "rejected by the user and not executed",
                    ),
                });
            }
          }
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
        results = nextResults;
        pendingTools = nextTools.filter((tool) => !results.has(tool.id));
        for (const message of messages) {
          if (!message.text) continue;
          const old = state.messages.find((m) => m.id === message.id);
          if (!old || old.text !== message.text || old.role !== message.role) {
            if (old) Object.assign(old, message);
            else state.messages.push({ ...message });
            emit("message.upsert", obs, message);
          }
        }
        interpretScreen(obs);
      }
      if (obs.kind === "process") {
        const previous = state.execution;
        if (!obs.identityConfirmed) state.execution = "unknown";
        else if (obs.alive)
          state.execution =
            state.interaction && state.interaction.state !== "unsupported"
              ? "awaiting-input"
              : state.interaction?.state === "unsupported"
                ? "unknown"
                : "running";
        else if (obs.exitCode === null) state.execution = "unknown";
        else if (obs.manifestStatus === "cancelled" || obs.requestedStop)
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
    toolResult(id) {
      return results.get(id);
    },
    setResponse(response) {
      state.response = { ...response, revision: state.revision + 1 };
      if (state.interaction?.id === response.interactionId)
        state.interaction.state =
          response.state === "not-submitted"
            ? "awaiting-response"
            : response.state;
      emit(
        "response.changed",
        {
          kind: "pty",
          seq: 0,
          observedAt: new Date().toISOString(),
          dataBase64: "",
        },
        state.response,
      );
      return snapshot();
    },
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
