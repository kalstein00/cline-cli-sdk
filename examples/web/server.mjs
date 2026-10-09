import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  createClient,
  readDiagnostic,
  compareDiagnostic,
} from "@cline-cli-sdk/sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";

let client = createClient({ mode: "replay" });
let preflight = null;
let managedExecutions = [];
let lastDiagnostics = null;
let diagnosticComparison = null;
const diagnosticDirectory =
  process.env.CLINE_SDK_DIAGNOSTIC_DIR ??
  join(tmpdir(), "cline-cli-sdk-diagnostics");
const streams = new Set();
const watch = () =>
  client.subscribe((event) => {
    for (const stream of streams)
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
  });
watch();
const fixtures = ["message", "question", "unsupported"];
const json = (response, status, value) => {
  if (value.snapshot) {
    value.diagnostics = client.diagnostics?.() ?? lastDiagnostics;
    value.diagnosticComparison = diagnosticComparison;
    value.diagnosticDirectory = diagnosticDirectory;
  }
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
        preflight,
        managedExecutions,
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
    if (
      request.method === "POST" &&
      [
        "/api/replay",
        "/api/connect",
        "/api/start",
        "/api/refresh",
        "/api/respond",
        "/api/stop",
        "/api/disconnect",
        "/api/managed",
        "/api/attach",
        "/api/diagnostics/start",
        "/api/diagnostics/stop",
        "/api/diagnostics/replay",
        "/api/reconfirm",
      ].includes(url.pathname)
    ) {
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
        if (body.length > 128000) {
          json(response, 413, { error: "request-too-large" });
          return;
        }
      }
      const input = JSON.parse(body);
      if (
        !client.capabilities().live &&
        [
          "/api/start",
          "/api/refresh",
          "/api/attach",
          "/api/disconnect",
          "/api/managed",
          "/api/stop",
          "/api/reconfirm",
          "/api/diagnostics/start",
          "/api/diagnostics/stop",
        ].includes(url.pathname)
      )
        throw Object.assign(
          new Error("Offline replay cannot invoke live operations."),
          { code: "replay-read-only" },
        );
      if (url.pathname === "/api/connect") {
        await client.stopDiagnostics?.();
        client.close();
        client = createClient({
          mode: "live",
          connection: {
            host: input.host,
            cliPath: input.cliPath || undefined,
            remoteRoot: input.remoteRoot || undefined,
            identityFile: input.identityFile || undefined,
          },
        });
        watch();
        diagnosticComparison = null;
        if (input.diagnostics)
          lastDiagnostics = await client.startDiagnostics(input.diagnostics);
        preflight = await client.connect();
        managedExecutions = preflight.ready
          ? await client.listManagedExecutions()
          : [];
        json(response, 200, {
          snapshot: client.snapshot(),
          capabilities: client.capabilities(),
          preflight,
          managedExecutions,
        });
        return;
      }
      if (url.pathname === "/api/diagnostics/start") {
        lastDiagnostics = await client.startDiagnostics(input);
        diagnosticComparison = null;
        json(response, 200, {
          snapshot: client.snapshot(),
          capabilities: client.capabilities(),
          preflight,
          managedExecutions,
        });
        return;
      }
      if (url.pathname === "/api/diagnostics/stop") {
        lastDiagnostics = await client.stopDiagnostics();
        json(response, 200, {
          snapshot: client.snapshot(),
          capabilities: client.capabilities(),
          preflight,
          managedExecutions,
        });
        return;
      }
      if (url.pathname === "/api/diagnostics/replay") {
        lastDiagnostics = (await client.stopDiagnostics?.()) ?? lastDiagnostics;
        const bundle = await readDiagnostic(input.path);
        lastDiagnostics = { ...bundle.metadata.status, path: input.path };
        client.close();
        client = createClient({ mode: "replay" });
        watch();
        const events = [];
        client.subscribe((e) => events.push(e));
        preflight = null;
        managedExecutions = [];
        await client.openReplay(bundle.recording);
        await client.replayAll();
        diagnosticComparison = {
          ...compareDiagnostic(bundle, events, client.snapshot()),
          truncated: bundle.recording.provenance.truncated,
          observations: bundle.recording.observations.length,
        };
        json(response, 200, {
          snapshot: client.snapshot(),
          capabilities: client.capabilities(),
          preflight,
          managedExecutions,
        });
        return;
      }
      if (url.pathname === "/api/disconnect") {
        client.disconnect();
        json(response, 200, {
          snapshot: client.snapshot(),
          capabilities: client.capabilities(),
          preflight,
          managedExecutions,
        });
        return;
      }
      if (url.pathname === "/api/managed") {
        managedExecutions = await client.listManagedExecutions();
        json(response, 200, {
          snapshot: client.snapshot(),
          capabilities: client.capabilities(),
          preflight,
          managedExecutions,
        });
        return;
      }
      if (url.pathname === "/api/attach") {
        const snapshot = await client.attach(input.executionId);
        json(response, 200, {
          snapshot,
          capabilities: client.capabilities(),
          preflight,
          managedExecutions,
        });
        return;
      }
      if (url.pathname === "/api/start") {
        const snapshot = await client.start({
          cwd: input.cwd,
          prompt: input.prompt,
          terminalMode: input.terminalMode || "tui",
          dataDir: input.dataDir || undefined,
          retryLimit:
            input.retryLimit === undefined
              ? undefined
              : Number(input.retryLimit),
        });
        json(response, 200, {
          snapshot,
          capabilities: client.capabilities(),
          preflight,
        });
        return;
      }
      if (url.pathname === "/api/reconfirm") {
        const snapshot = await client.reconfirmDelivery();
        json(response, 200, {
          snapshot,
          capabilities: client.capabilities(),
          preflight,
          managedExecutions,
        });
        return;
      }
      if (url.pathname === "/api/refresh") {
        const snapshot = await client.refresh();
        json(response, 200, {
          snapshot,
          capabilities: client.capabilities(),
          preflight,
        });
        return;
      }
      if (url.pathname === "/api/respond") {
        const result = await client.respond(input);
        json(response, 200, {
          result,
          snapshot: client.snapshot(),
          capabilities: client.capabilities(),
          preflight,
        });
        return;
      }
      if (url.pathname === "/api/stop") {
        const result = await client.stop(input);
        json(response, 200, {
          result,
          snapshot: client.snapshot(),
          capabilities: client.capabilities(),
          preflight,
        });
        return;
      }
      const { fixture } = input;
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
      client.close();
      client = createClient({ mode: "replay" });
      watch();
      preflight = null;
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
      snapshot: client.snapshot(),
      capabilities: client.capabilities(),
      preflight,
    });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Cline SDK example: http://127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await client.stopDiagnostics?.();
    client.close();
    for (const stream of streams) stream.end();
    server.close();
  });
