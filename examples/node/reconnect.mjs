import { createClient } from "@cline-cli-sdk/sdk";

const client = createClient({mode: "live", connection: {
  host: process.env.CLINE_SDK_HOST ?? "wsl",
  cliPath: process.env.CLINE_SDK_CLI_PATH ?? process.env.CLINE_SDK_CLI,
  remoteRoot: process.env.CLINE_SDK_REMOTE_ROOT,
  identityFile: process.env.CLINE_SDK_IDENTITY_FILE,
  sessionDirectory: process.env.CLINE_SDK_SESSION_DIRECTORY,
}});
try {
  await client.connect();
  const runs = await client.listManagedExecutions();
  console.log(JSON.stringify({managedExecutions: runs}, null, 2));
  const executionId = process.env.CLINE_SDK_EXECUTION_ID;
  if (executionId) {
    if (!runs.some(run => run.executionId === executionId)) throw Error("The selected execution/history is not listed.");
    console.log(JSON.stringify(await client.attach(executionId), null, 2));
  } else {
    console.log("Select a listed ID with CLINE_SDK_EXECUTION_ID, then run again. History is never selected automatically.");
  }
} finally {
  client.close();
}
