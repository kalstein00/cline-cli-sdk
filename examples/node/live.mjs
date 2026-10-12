import { createClient } from "@cline-cli-sdk/sdk";
const client = createClient({
  mode: "live",
  connection: {
    host: process.env.CLINE_SDK_HOST ?? "wsl",
    cliPath: process.env.CLINE_SDK_CLI_PATH,
    remoteRoot: process.env.CLINE_SDK_REMOTE_ROOT,
    identityFile: process.env.CLINE_SDK_IDENTITY_FILE,
  },
});
try {
  const preflight = await client.connect();
  console.log(JSON.stringify({ preflight }));
  if (!preflight.ready) process.exitCode = 1;
  else if (process.env.CLINE_SDK_WORKSPACE) {
    await client.start({
      cwd: process.env.CLINE_SDK_WORKSPACE,
      prompt:
        process.env.CLINE_SDK_PROMPT ??
        "Reply exactly SDK_LIVE_READY. Do not call any tools.",
      dataDir: process.env.CLINE_SDK_DATA_DIR,
    });
    const deadline = Date.now() + 90000;
    let state;
    do {
      state = await client.refresh();
      if (
        ["completed", "stopped", "failed", "awaiting-input"].includes(
          state.execution,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    } while (Date.now() < deadline);
    console.log(JSON.stringify({ snapshot: state }));
    if (state.execution !== "completed") process.exitCode = 1;
  }
} finally {
  client.close();
}
