import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCursorSdkRunner } from "../src/cursor-sdk-runner.js";

async function createContext() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cursor-sdk-runner-test-"));
  const workspace = path.join(root, "workspace");
  const outputDir = path.join(root, "output");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
  ]);
  const apiKeyFile = path.join(root, "cursor-api-key.txt");
  await writeFile(apiKeyFile, "test-cursor-key\n", "utf8");
  const controller = new AbortController();
  const stdout = [];
  const stderr = [];
  const events = [];
  return {
    apiKeyFile,
    root,
    workspace,
    outputDir,
    controller,
    stdout,
    stderr,
    events,
    context: {
      job: { id: "job-test", idempotencyKey: "idem-test" },
      prompt: "Inspect the workspace",
      workspace,
      outputDir,
      signal: controller.signal,
      onStdout: (text) => stdout.push(text),
      onStderr: (text) => stderr.push(text),
      onEvent: (event) => events.push(event),
    },
  };
}

function createFakeSdk(options = {}) {
  const state = {
    createOptions: undefined,
    createCount: 0,
    resumeAgentId: undefined,
    resumeOptions: undefined,
    sendOptions: undefined,
    cancelCount: 0,
    disposeCount: 0,
  };
  let resolveCancel;
  const cancelled = new Promise((resolve) => {
    resolveCancel = resolve;
  });

  const run = {
    id: "run-test",
    agentId: "agent-test",
    status: "running",
    supports: (operation) => operation === "cancel",
    async *stream() {
      for (const event of options.events ?? []) {
        yield event;
      }
      if (options.waitForCancel) {
        await cancelled;
      }
    },
    async wait() {
      return options.result ?? { id: "run-test", status: "finished", result: "final answer" };
    },
    async cancel() {
      state.cancelCount += 1;
      resolveCancel();
    },
  };

  const agent = {
    agentId: "agent-test",
    async send(_prompt, sendOptions) {
      state.sendOptions = sendOptions;
      return run;
    },
    async [Symbol.asyncDispose]() {
      state.disposeCount += 1;
    },
  };

  return {
    state,
    sdk: {
      Agent: {
        async create(createOptions) {
          state.createCount += 1;
          state.createOptions = createOptions;
          if (options.createError) {
            throw options.createError;
          }
          return agent;
        },
        async resume(agentId, resumeOptions) {
          state.resumeAgentId = agentId;
          state.resumeOptions = resumeOptions;
          return agent;
        },
      },
    },
  };
}

test("cursor-sdk runner streams events, writes final.md, and disposes the agent", async () => {
  const fixture = await createContext();
  const fake = createFakeSdk({
    events: [
      { type: "system", agent_id: "agent-test", run_id: "run-test", model: { id: "composer-2" } },
      {
        type: "assistant",
        agent_id: "agent-test",
        run_id: "run-test",
        message: { role: "assistant", content: [{ type: "text", text: "Inspecting files" }] },
      },
      {
        type: "tool_call",
        agent_id: "agent-test",
        run_id: "run-test",
        call_id: "call-1",
        name: "read",
        status: "completed",
        args: { path: "README.md" },
        result: { ok: true },
      },
      { type: "thinking", agent_id: "agent-test", run_id: "run-test", text: "checking structure" },
      { type: "usage", agent_id: "agent-test", run_id: "run-test", usage: { inputTokens: 10 } },
    ],
    result: {
      id: "run-test",
      requestId: "request-test",
      status: "finished",
      result: "FINAL REPORT",
      model: { id: "composer-2" },
      durationMs: 25,
      usage: { inputTokens: 10 },
    },
  });
  const result = await runCursorSdkRunner(
    {
      model: "composer-2",
      apiKeyFile: fixture.apiKeyFile,
      settingSources: [],
      autoReview: true,
    },
    fixture.context,
    { sdk: fake.sdk },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.metadata.agentId, "agent-test");
  assert.equal(result.metadata.runId, "run-test");
  assert.equal(fake.state.createOptions.model.id, "composer-2");
  assert.equal(fake.state.createOptions.local.cwd, fixture.workspace);
  assert.equal(fake.state.createOptions.local.autoReview, true);
  assert.equal(fake.state.sendOptions.idempotencyKey, "idem-test");
  assert.equal(fake.state.disposeCount, 1);
  assert.equal(fake.state.createCount, 1);
  assert.equal(fixture.events.some((event) => event.kind === "thinking"), true);
  assert.equal(fixture.events.some((event) => event.kind === "tool" && event.name === "read"), true);
  assert.equal(fixture.events.some((event) => event.kind === "usage"), true);
  assert.equal((await readFile(path.join(fixture.outputDir, "final.md"), "utf8")).trim(), "FINAL REPORT");
  assert.equal((await readFile(path.join(fixture.outputDir, "prompt.txt"), "utf8")), "Inspect the workspace");
});

test("cursor-sdk runner resumes an existing agent for a continued conversation", async () => {
  const fixture = await createContext();
  fixture.context.agentId = "agent-11111111-1111-4111-8111-111111111111";
  const fake = createFakeSdk();
  const result = await runCursorSdkRunner(
    { model: "composer-2", apiKeyFile: fixture.apiKeyFile },
    fixture.context,
    { sdk: fake.sdk },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(fake.state.createCount, 0);
  assert.equal(fake.state.resumeAgentId, fixture.context.agentId);
  assert.equal(fake.state.resumeOptions.local.cwd, fixture.workspace);
  assert.match(fixture.stdout.join(""), /resuming local agent/);
});

test("cursor-sdk runner cancels the remote run when the bridge job is cancelled", async () => {
  const fixture = await createContext();
  const fake = createFakeSdk({
    waitForCancel: true,
    events: [
      {
        type: "status",
        agent_id: "agent-test",
        run_id: "run-test",
        status: "RUNNING",
      },
    ],
    result: { id: "run-test", status: "cancelled" },
  });
  const execution = runCursorSdkRunner(
    { model: "composer-2", apiKeyFile: fixture.apiKeyFile },
    fixture.context,
    { sdk: fake.sdk },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  fixture.controller.abort(new Error("job cancelled"));
  const result = await execution;

  assert.equal(fake.state.cancelCount, 1);
  assert.equal(fake.state.disposeCount, 1);
  assert.equal(result.metadata.cursorStatus, "cancelled");
  assert.equal(result.exitCode, 1);
});

test("cursor-sdk runner preserves terminal run errors in the job result", async () => {
  const fixture = await createContext();
  const fake = createFakeSdk({
    result: {
      id: "run-test",
      status: "error",
      error: { code: "model_error", message: "model failed" },
    },
  });
  const result = await runCursorSdkRunner(
    { model: "composer-2", apiKeyFile: fixture.apiKeyFile },
    fixture.context,
    { sdk: fake.sdk },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.error, "model failed");
  assert.equal(result.metadata.cursorStatus, "error");
  assert.match(await readFile(path.join(fixture.outputDir, "final.md"), "utf8"), /model_error/);
  assert.equal(fake.state.disposeCount, 1);
});

test("cursor-sdk runner reports startup failures and a missing API key clearly", async () => {
  const fixture = await createContext();
  const startupError = new Error("invalid API key");
  startupError.code = "authentication_failed";
  const fake = createFakeSdk({ createError: startupError });
  await assert.rejects(
    runCursorSdkRunner(
      { model: "composer-2", apiKeyFile: fixture.apiKeyFile },
      fixture.context,
      { sdk: fake.sdk },
    ),
    /invalid API key/,
  );

  const previousKey = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  try {
    await assert.rejects(
      runCursorSdkRunner(
        {
          model: "composer-2",
          apiKeyFile: path.join(fixture.root, "missing.txt"),
          allowStoredAuth: false,
        },
        fixture.context,
        { sdk: fake.sdk },
      ),
      /Cursor API key is not configured/,
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.CURSOR_API_KEY;
    } else {
      process.env.CURSOR_API_KEY = previousKey;
    }
  }
});
