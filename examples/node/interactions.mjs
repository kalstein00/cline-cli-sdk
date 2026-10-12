import { createClient } from "@cline-cli-sdk/sdk";
import { randomUUID } from "node:crypto";

const scenario = process.argv[2] ?? "choice";
const prompts = {
  choice:
    "Controlled SDK example. First call ask_question with question Choose SDK color. and exactly the options RED and BLUE. Wait for the human answer. Then reply exactly SDK_COLOR:<answer> and finish. Do not call other tools.",
  approve:
    "Controlled SDK example. Call run_commands exactly once with the command printf APPROVAL_PROBE. Wait for tool approval. If it succeeds reply exactly SDK_APPROVED:APPROVAL_PROBE and finish. Do not use other tools or retry.",
  deny: "Controlled SDK example. Call run_commands exactly once with the command printf DENIAL_SHOULD_NOT_EXECUTE. Wait for tool approval. If denied do not retry or use another tool. Reply exactly SDK_DENIED and finish.",
};
if (!prompts[scenario])
  throw new Error("Scenario must be choice, approve, or deny.");
const client = createClient({
  mode: "live",
  connection: {
    host: process.env.CLINE_SDK_HOST ?? "wsl",
    cliPath: process.env.CLINE_SDK_CLI_PATH,
    remoteRoot: process.env.CLINE_SDK_REMOTE_ROOT,
  },
});
async function waitFor(predicate) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const state = await client.refresh();
    if (predicate(state)) return state;
    if (["completed", "stopped", "failed"].includes(state.execution))
      throw new Error(
        `Task ended before the expected interaction: ${state.execution}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    "Observation deadline reached; the remote task was not stopped.",
  );
}
async function answer(value) {
  const state = client.snapshot();
  console.log("Current interaction:", state.interaction);
  const result = await client.respond({
    sessionId: state.sessionId,
    executionId: state.executionId,
    interactionId: state.interaction.id,
    revision: state.revision,
    requestId: randomUUID(),
    answer: value,
  });
  console.log("Response:", result);
  if (result.state !== "delivered")
    throw new Error("Delivery is uncertain; no response will be resent.");
}
try {
  const report = await client.connect();
  if (!report.ready) throw new Error(report.problems.join(", "));
  await client.start({
    cwd: process.env.CLINE_SDK_WORKSPACE,
    prompt: prompts[scenario],
    dataDir: process.env.CLINE_SDK_DATA_DIR,
    retryLimit: process.env.CLINE_SDK_RETRY_LIMIT
      ? Number(process.env.CLINE_SDK_RETRY_LIMIT)
      : undefined,
  });
  await waitFor(
    (s) =>
      s.interaction?.kind === "approval" &&
      s.interaction.responseKinds?.includes("approval"),
  );
  await answer(scenario === "deny" ? "Deny" : "Approve");
  if (scenario === "choice") {
    await waitFor(
      (s) =>
        s.interaction?.kind === "question" &&
        s.interaction.responseKinds?.includes("choice"),
    );
    await answer("BLUE");
  }
  if (scenario === "deny") {
    await waitFor(
      (s) =>
        s.interaction?.kind === "recovery" &&
        s.interaction.responseKinds?.includes("choice"),
    );
    await answer("Stop this run");
  }
  console.log(
    await waitFor((s) =>
      ["completed", "stopped", "failed"].includes(s.execution),
    ),
  );
} finally {
  client.close();
}
