import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createBridgeServer } from "../src/server.js";

export async function createTestBridge(runnerConfig = undefined, overrides = {}, customRunner = undefined) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cursor-remote-bridge-test-"));
  const workspace = path.join(temp, "workspace");
  await mkdir(workspace, { recursive: true });
  const configPath = path.join(temp, "bridge.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: 0,
      publicDir: path.join(process.cwd(), "public"),
      dataDir: path.join(temp, "data"),
      tokenFile: path.join(temp, "data", "api-token.txt"),
      allowedWorkspaces: [workspace],
      maxConcurrentJobs: 1,
      maxQueuedJobs: 4,
      maxOutputBytes: 1024 * 1024,
      defaultTimeoutSeconds: 60,
      runner:
        runnerConfig ??
        ({
          mode: "command",
          command: process.execPath,
          args: [path.join(process.cwd(), "scripts", "fake-cursor-task.js")],
        }),
      ...overrides,
    }),
    "utf8",
  );
  const config = await loadConfig({
    configPath,
    apiToken: "test-token-that-is-long-enough-1234567890",
    allowEphemeralPort: true,
  });
  const bridge = await createBridgeServer({ config, runner: customRunner });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const address = bridge.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    ...bridge,
    temp,
    workspace,
    baseUrl,
    headers: {
      authorization: "Bearer test-token-that-is-long-enough-1234567890",
      "content-type": "application/json",
    },
    close: () => new Promise((resolve) => bridge.server.close(resolve)),
  };
}

export async function waitForJob(bridge, jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${bridge.baseUrl}/v1/jobs/${jobId}`, {
      headers: bridge.headers,
    });
    const body = await response.json();
    if (!["queued", "running"].includes(body.job.status)) {
      return body.job;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`job ${jobId} did not finish`);
}
