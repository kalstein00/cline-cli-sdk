import { createClient } from "@cline-cli-sdk/sdk";

const client = createClient({
  mode: "live",
  connection: {
    host: process.env.CLINE_SDK_HOST ?? "wsl",
    cliPath: process.env.CLINE_SDK_CLI,
    remoteRoot: process.env.CLINE_SDK_REMOTE_ROOT,
  },
});
try {
  const report = await client.connect();
  if (!report.ready) throw new Error(report.problems.join(", "));
  const runs = await client.listManagedExecutions();
  console.log(JSON.stringify({ managedExecutions: runs }, null, 2));
  const selected = process.env.CLINE_SDK_EXECUTION_ID
    ? runs.find((run) => run.executionId === process.env.CLINE_SDK_EXECUTION_ID)
    : (runs.find((run) => run.alive && run.identityConfirmed) ?? runs[0]);
  if (selected)
    console.log(
      JSON.stringify(await client.attach(selected.executionId), null, 2),
    );
} finally {
  client.close();
}
