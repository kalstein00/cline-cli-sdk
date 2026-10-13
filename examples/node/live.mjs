import { createClient } from "@cline-cli-sdk/sdk";

if (process.env.CLINE_SDK_DATA_DIR)
  throw Error("Isolated dataDir is unsupported. Use native CLI settings; see docs/direct-ssh.md.");
const client = createClient({mode: "live", connection: {
  host: process.env.CLINE_SDK_HOST ?? "wsl",
  cliPath: process.env.CLINE_SDK_CLI_PATH,
  remoteRoot: process.env.CLINE_SDK_REMOTE_ROOT,
  identityFile: process.env.CLINE_SDK_IDENTITY_FILE,
  sessionDirectory: process.env.CLINE_SDK_SESSION_DIRECTORY,
}});
try {
  const preflight = await client.connect();
  console.log(JSON.stringify({preflight}));
  if (!preflight.ready) process.exitCode = 1;
  else if (process.env.CLINE_SDK_WORKSPACE) {
    await client.start({
      cwd: process.env.CLINE_SDK_WORKSPACE,
      prompt: process.env.CLINE_SDK_PROMPT ?? "Reply exactly SDK_LIVE_READY. Do not call any tools.",
      terminalMode: "tui",
    });
    // One read-only observation is not a completion or delivery receipt.
    console.log(JSON.stringify({snapshot: await client.refresh()}));
    console.log("Remote CLI continues independently. Use its tmux session for interaction; select saved JSON separately.");
  }
} finally {
  client.close();
}
