import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createClient } from "@cline-cli-sdk/sdk";

const client = createClient({ mode: "replay" });
const streams = new Set();
client.subscribe((event) => {
  for (const stream of streams)
    stream.write(`data: ${JSON.stringify(event)}\n\n`);
});
const fixtures = ["message", "question", "unsupported"];
const json = (response, status, value) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
};
const port = Number(process.env.CLINE_SDK_PORT ?? 4173);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(await readFile(new URL("./index.html", import.meta.url)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, {
        snapshot: client.snapshot(),
        capabilities: client.capabilities(),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/replay") {
      const origin = request.headers.origin;
      if (
        (origin &&
          origin !== `http://127.0.0.1:${port}` &&
          origin !== `http://localhost:${port}`) ||
        request.headers["content-type"] !== "application/json"
      ) {
        json(response, 403, { error: "local-json-only" });
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024) {
          json(response, 413, { error: "request-too-large" });
          return;
        }
      }
      const { fixture } = JSON.parse(body);
      if (!fixtures.includes(fixture)) {
        json(response, 400, { error: "unknown-fixture" });
        return;
      }
      const recording = JSON.parse(
        await readFile(
          new URL(`../../fixtures/${fixture}.json`, import.meta.url),
          "utf8",
        ),
      );
      await client.openReplay(recording);
      await client.replayAll();
      json(response, 200, {
        snapshot: client.snapshot(),
        capabilities: client.capabilities(),
      });
      return;
    }
    json(response, 404, { error: "not-found" });
  } catch (error) {
    json(response, 400, {
      error: error.code ?? "invalid-request",
      message: error.message,
    });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Replay example: http://127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    client.close();
    for (const stream of streams) stream.end();
    server.close();
  });
