import { createClient } from "@cline-cli-sdk/sdk";
import { readFile } from "node:fs/promises";

const client = createClient({ mode: "replay" });
client.subscribe((event) => console.log(JSON.stringify(event)));
await client.openReplay(
  JSON.parse(
    await readFile(
      new URL("../../fixtures/question.json", import.meta.url),
      "utf8",
    ),
  ),
);
await client.replayAll();
console.log(JSON.stringify(client.snapshot(), null, 2));
client.close();
