import {
  createClient,
  reviewDiagnostic,
  inspectDiagnostic,
  previewDiagnosticExport,
  exportDiagnostic,
  readDiagnostic,
  compareDiagnostic,
} from "@cline-cli-sdk/sdk";
const [command, path, ...args] = process.argv.slice(2);
if (!path || !["review", "content", "export", "replay"].includes(command))
  throw Error(
    "Usage: export.mjs review|content|export|replay <recording-path> [index offset | new-directory masks...]",
  );
const review = await reviewDiagnostic(path);
if (command === "review") console.log(JSON.stringify(review, null, 2));
if (command === "content")
  console.log(
    JSON.stringify(
      await inspectDiagnostic(path, {
        index: Number(args[0] ?? 0),
        offset: Number(args[1] ?? 0),
        reviewToken: review.reviewToken,
      }),
      null,
      2,
    ),
  );
if (command === "export") {
  if (!args[0])
    throw Error(
      "Choose a new local directory; existing files are never overwritten.",
    );
  const options = {
    destination: args[0],
    reviewToken: review.reviewToken,
    masks: args.slice(1),
  };
  console.log(
    JSON.stringify(
      {
        preview: await previewDiagnosticExport(path, options),
        exported: await exportDiagnostic(path, options),
      },
      null,
      2,
    ),
  );
}
if (command === "replay") {
  if (review.replay.state === "blocked") throw Error(review.replay.reason);
  const bundle = await readDiagnostic(path),
    client = createClient({ mode: "replay" }),
    events = [];
  client.subscribe((e) => events.push(e));
  await client.openReplay(bundle.recording);
  await client.replayAll();
  console.log(
    JSON.stringify(
      {
        review,
        comparison: compareDiagnostic(bundle, events, client.snapshot()),
        snapshot: client.snapshot(),
      },
      null,
      2,
    ),
  );
  client.close();
}
