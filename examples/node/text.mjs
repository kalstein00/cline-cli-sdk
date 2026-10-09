import { createClient } from "@cline-cli-sdk/sdk";
const connection = {
  host: process.env.CLINE_SDK_HOST || "wsl",
  cliPath: process.env.CLINE_SDK_CLI_PATH,
  remoteRoot: process.env.CLINE_SDK_REMOTE_ROOT,
  responseTimeoutMs: 60000,
};
const answers = {
  TEXT_NORMAL: "CUSTOM-42",
  TEXT_NUMERIC: "2 custom identifier",
  TEXT_KOREAN: "한글 응답 가나다 😀 café",
  TEXT_LONG:
    "LONG_" + "abcdefghijklmnopqrstuvwxyz0123456789".repeat(20) + "_끝",
};
const client = createClient({ mode: "live", connection });
console.log(JSON.stringify({ preflight: await client.connect() }));
await client.start({
  cwd: process.env.CLINE_SDK_WORKSPACE,
  dataDir: process.env.CLINE_SDK_DATA_DIR,
  terminalMode: "tui",
  prompt:
    "First run exactly printf TUI_APPROVAL_PROBE using run_commands. Then use ask_question four times sequentially, never in parallel. Questions must be exactly TEXT_NORMAL, TEXT_NUMERIC, TEXT_KOREAN, TEXT_LONG. Each has options RED and BLUE. Wait for each response before asking the next. After all four, reply exactly TEXT_ALL_RECEIVED. Do not use any other tools.",
});
const answered = new Set();
const deadline = Date.now() + 300000;
try {
  while (Date.now() < deadline) {
    await client.refresh();
    const s = client.snapshot();
    const i = s.interaction;
    console.log(
      JSON.stringify({
        execution: s.execution,
        sessionId: s.sessionId,
        executionId: s.executionId,
        interaction: i,
        response: s.response,
        messages: s.messages.slice(-1),
      }),
    );
    if (i?.state === "unsupported") throw new Error(i.prompt);
    if (i?.state === "awaiting-response" && !answered.has(i.id)) {
      const answer = i.kind === "approval" ? "Approve" : answers[i.prompt];
      if (!answer) throw new Error("Unexpected interaction " + i.prompt);
      const result = await client.respond({
        sessionId: s.sessionId,
        executionId: s.executionId,
        interactionId: i.id,
        revision: s.revision,
        requestId: crypto.randomUUID(),
        answer,
      });
      console.log(
        JSON.stringify({
          answer,
          utf8Bytes: Buffer.byteLength(answer),
          result,
        }),
      );
      if (result.state !== "delivered")
        throw new Error("Delivery not confirmed");
      answered.add(i.id);
    }
    if (
      s.messages.some(
        (m) => m.role === "assistant" && m.text === "TEXT_ALL_RECEIVED",
      )
    ) {
      console.log(
        JSON.stringify({
          success: true,
          answers,
          sessionId: s.sessionId,
          executionId: s.executionId,
        }),
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (Date.now() >= deadline)
    throw new Error("Acceptance observation deadline");
} finally {
  client.close();
}
