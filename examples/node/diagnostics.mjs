import {createClient, readDiagnostic, compareDiagnostic} from "@cline-cli-sdk/sdk";
import {tmpdir} from "node:os";
import {join} from "node:path";

if (process.argv[2] === "replay") {
  const bundle = await readDiagnostic(process.argv[3]);
  const client = createClient({mode: "replay"});
  try {
    const events = [];
    client.subscribe(event => events.push(event));
    await client.openReplay(bundle.recording);
    await client.replayAll();
    console.log(JSON.stringify({comparison: compareDiagnostic(bundle, events, client.snapshot()), snapshot: client.snapshot()}, null, 2));
  } finally { client.close(); }
} else {
  // Read a selected observation without launching a question this mode cannot answer.
  const failure = process.argv[2] === "failure";
  const client = createClient({mode: "live", connection: {
    host: process.env.CLINE_SDK_HOST ?? "wsl",
    cliPath: process.env.CLINE_SDK_CLI_PATH,
    remoteRoot: process.env.CLINE_SDK_REMOTE_ROOT,
    identityFile: process.env.CLINE_SDK_IDENTITY_FILE,
    sessionDirectory: process.env.CLINE_SDK_SESSION_DIRECTORY,
    ...(failure ? {sshExecutable: "cline-sdk-diagnostics-intentionally-missing-ssh"} : {}),
  }});
  try {
    await client.startDiagnostics({directory: process.env.CLINE_SDK_DIAGNOSTIC_DIR ?? join(tmpdir(), "cline-cli-sdk-diagnostics")});
    console.log(JSON.stringify({preflight: await client.connect()}));
    const executionId = process.env.CLINE_SDK_EXECUTION_ID;
    if (executionId) console.log(JSON.stringify({snapshot: await client.attach(executionId)}));
    else {
      console.log(JSON.stringify({managedExecutions: await client.listManagedExecutions()}));
      console.log("Set CLINE_SDK_EXECUTION_ID to capture selected history or tmux observations. Diagnostics are partial.");
    }
  } catch (error) {
    if (!failure) process.exitCode = 1;
    console.error(JSON.stringify({error: error.code ?? "observation-failed", message: error.message}));
  } finally {
    console.log(JSON.stringify({diagnostic: await client.stopDiagnostics()}));
    client.close();
  }
}
