import {
  createClient,
  readDiagnostic,
  compareDiagnostic,
} from "@cline-cli-sdk/sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.argv[2] === "replay") {
  const bundle = await readDiagnostic(process.argv[3]);
  const client = createClient({ mode: "replay" });
  const events = [];
  client.subscribe((e) => events.push(e));
  await client.openReplay(bundle.recording);
  await client.replayAll();
  console.log(
    JSON.stringify(
      {
        comparison: compareDiagnostic(bundle, events, client.snapshot()),
        snapshot: client.snapshot(),
      },
      null,
      2,
    ),
  );
  client.close();
} else {
  const failure = process.argv[2] === "failure";
  const client = createClient({
    mode: "live",
    connection: {
      host: process.env.CLINE_SDK_HOST ?? "wsl",
      cliPath: process.env.CLINE_SDK_CLI_PATH,
      remoteRoot: process.env.CLINE_SDK_REMOTE_ROOT,
      responseTimeoutMs: 60000,
      ...(failure
        ? { sshExecutable: "cline-sdk-diagnostics-intentionally-missing-ssh" }
        : {}),
    },
  });
  await client.startDiagnostics({
    directory:
      process.env.CLINE_SDK_DIAGNOSTIC_DIR ??
      join(tmpdir(), "cline-cli-sdk-diagnostics"),
  });
  try {
    const preflight = await client.connect();
    if (!preflight.ready) throw Error("Environment prerequisites not ready");
    await client.start({
      cwd: process.env.CLINE_SDK_WORKSPACE,
      dataDir: process.env.CLINE_SDK_DATA_DIR,
      terminalMode: "tui",
      prompt:
        "Controlled diagnostic acceptance. Use ask_question exactly once with question DIAGNOSTIC_COLOR and options RED and BLUE. Wait for the human. Accept ANY human answer, including arbitrary custom text, as valid. After receiving any answer reply exactly DIAGNOSTIC_DONE and finish. Do not request clarification, ask again, or call any other tool.",
    });
    const answered = new Set();
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await client.refresh();
      const s = client.snapshot();
      const i = s.interaction;
      if (i?.state === "unsupported") throw Error(i.prompt);
      if (i?.state === "awaiting-response" && !answered.has(i.id)) {
        const result = await client.respond({
          sessionId: s.sessionId,
          executionId: s.executionId,
          interactionId: i.id,
          revision: s.revision,
          requestId: crypto.randomUUID(),
          answer: i.kind === "approval" ? "Approve" : "2 진단 응답 😀",
        });
        if (result.state !== "delivered")
          throw Error("Response delivery remains unknown");
        answered.add(i.id);
      }
      if (
        ["completed", "stopped", "failed"].includes(client.snapshot().execution)
      )
        break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (client.snapshot().execution !== "completed")
      throw Error("Task completion not witnessed");
  } catch (error) {
    if (!failure) process.exitCode = 1;
    console.error(
      JSON.stringify({
        error: error.code ?? "acceptance-failed",
        message: error.message,
      }),
    );
  } finally {
    const diagnostic = await client.stopDiagnostics();
    console.log(
      JSON.stringify({
        diagnostic,
        execution: client.snapshot().execution,
        sessionId: client.snapshot().sessionId,
        executionId: client.snapshot().executionId,
      }),
    );
    if (diagnostic.path) {
      const bundle = await readDiagnostic(diagnostic.path);
      const replay = createClient({ mode: "replay" });
      const events = [];
      replay.subscribe((e) => events.push(e));
      await replay.openReplay(bundle.recording);
      await replay.replayAll();
      const comparison = compareDiagnostic(bundle, events, replay.snapshot());
      console.log(JSON.stringify({ comparison }));
      if (!comparison.matches) process.exitCode = 1;
      replay.close();
    }
    client.close();
  }
}
