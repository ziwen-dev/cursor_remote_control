import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestBridge, waitForJob } from "./helpers.js";

const TEST_AGENT_ID = "agent-11111111-1111-4111-8111-111111111111";

function createConversationRunner() {
  return {
    mode: "test-agent",
    async execute(context) {
      context.onStdout(`running ${context.prompt}\n`);
      context.onEvent({ kind: "thinking", text: `considering ${context.prompt}` });
      context.onEvent({
        kind: "tool",
        status: "completed",
        name: "read",
        args: { path: "README.md" },
        result: { ok: true },
      });
      await writeFile(
        path.join(context.outputDir, "final.md"),
        `## Answer\n\nReply for **${context.prompt}**\n`,
        "utf8",
      );
      return { exitCode: 0, signal: null, metadata: { agentId: TEST_AGENT_ID } };
    },
  };
}

test("health works and protected APIs reject a missing token", async (t) => {
  const bridge = await createTestBridge();
  t.after(() => bridge.close());
  const health = await fetch(`${bridge.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const denied = await fetch(`${bridge.baseUrl}/v1/meta`);
  assert.equal(denied.status, 401);
});

test("web client script is served and can reach the protected API", async (t) => {
  const bridge = await createTestBridge();
  t.after(() => bridge.close());
  const script = await fetch(`${bridge.baseUrl}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /text\/javascript/);
  const scriptText = await script.text();
  assert.match(scriptText, /new-conversation/);
  assert.match(scriptText, /conversations/);
  const marked = await fetch(`${bridge.baseUrl}/vendor/marked.min.js`);
  assert.equal(marked.status, 200);
  assert.match(marked.headers.get("content-type"), /text\/javascript/);
  const purify = await fetch(`${bridge.baseUrl}/vendor/purify.min.js`);
  assert.equal(purify.status, 200);
  const themeScript = await fetch(`${bridge.baseUrl}/theme-init.js`);
  assert.equal(themeScript.status, 200);
  assert.match(await themeScript.text(), /bridge-theme/);
  assert.match(scriptText, /workspace-group/);
  assert.match(scriptText, /theme-toggle/);
  const localToken = await (await fetch(`${bridge.baseUrl}/local-token`)).json();
  assert.equal(localToken.token, "test-token-that-is-long-enough-1234567890");
});

test("responsive client assets are served and protect against horizontal overflow", async (t) => {
  const bridge = await createTestBridge();
  t.after(() => bridge.close());
  const html = await (await fetch(`${bridge.baseUrl}/`)).text();
  const script = await (await fetch(`${bridge.baseUrl}/app.js`)).text();
  const theme = await (await fetch(`${bridge.baseUrl}/theme-init.js`)).text();
  assert.match(html, /id="mobile-menu"/);
  assert.match(html, /overflow:hidden/);
  assert.match(html, /data-theme="light"/);
  assert.match(script, /workspace-group/);
  assert.match(script, /button\.title =/);
  assert.match(script, /renderMarkdownPreview/);
  assert.match(script, /file-preview-mode/);
  assert.match(html, /file-preview-mode/);
  assert.match(html, /file-markdown/);
  assert.match(theme, /prefers-color-scheme/);
});

test("local workspace browser can inspect folders and add a new allowlisted workspace", async (t) => {
  const bridge = await createTestBridge();
  t.after(() => bridge.close());
  const listing = await fetch(`${bridge.baseUrl}/local-workspace-browse?path=${encodeURIComponent(bridge.workspace)}`);
  assert.equal(listing.status, 200);
  const body = await listing.json();
  assert.equal(body.path, bridge.workspace);
  assert.ok(Array.isArray(body.entries));

  const nested = path.join(bridge.temp, "nested-workspace");
  await mkdir(nested, { recursive: true });
  const add = await fetch(`${bridge.baseUrl}/local-workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: nested }),
  });
  assert.equal(add.status, 200);
  const added = await add.json();
  assert.equal(added.workspace, nested);
  assert.ok(added.allowedWorkspaces.some((entry) => entry.toLowerCase() === nested.toLowerCase()));

  const job = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify({
      workspace: nested,
      prompt: "workspace newly added",
      timeoutSeconds: 20,
      idempotencyKey: "new-workspace",
    }),
  });
  assert.equal(job.status, 202);
});

test("workspace removal updates the allowlist and preserves at least one workspace", async (t) => {
  const bridge = await createTestBridge();
  t.after(() => bridge.close());
  const nested = path.join(bridge.temp, "removable-workspace");
  await mkdir(nested, { recursive: true });
  const addResponse = await fetch(`${bridge.baseUrl}/local-workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: nested }),
  });
  assert.equal(addResponse.status, 200);

  const removeResponse = await fetch(`${bridge.baseUrl}/local-workspaces`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: nested }),
  });
  assert.equal(removeResponse.status, 200);
  const removed = await removeResponse.json();
  assert.equal(removed.removed, nested);
  assert.ok(!removed.allowedWorkspaces.some((entry) => entry.toLowerCase() === nested.toLowerCase()));

  const blocked = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify({
      workspace: nested,
      prompt: "removed workspace must be blocked",
      timeoutSeconds: 20,
      idempotencyKey: "removed-workspace",
    }),
  });
  assert.equal(blocked.status, 403);

  const last = await fetch(`${bridge.baseUrl}/local-workspaces`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: bridge.workspace }),
  });
  assert.equal(last.status, 409);
  assert.equal((await last.json()).code, "last_workspace");
});

test("continued jobs are grouped into one persisted conversation with activity", async (t) => {
  const bridge = await createTestBridge(undefined, {}, createConversationRunner());
  t.after(() => bridge.close());
  const create = async (prompt, agentId) => {
    const response = await fetch(`${bridge.baseUrl}/v1/jobs`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({
        workspace: bridge.workspace,
        prompt,
        timeoutSeconds: 20,
        idempotencyKey: prompt,
        ...(agentId ? { agentId } : {}),
      }),
    });
    assert.equal(response.status, 202);
    return (await response.json()).job;
  };

  const first = await create("HISTORY-ONE");
  const firstDone = await waitForJob(bridge, first.id);
  assert.equal(firstDone.agentId, TEST_AGENT_ID);
  const second = await create("what did I say?", TEST_AGENT_ID);
  await waitForJob(bridge, second.id);

  const body = await (await fetch(`${bridge.baseUrl}/v1/conversations`, {
    headers: bridge.headers,
  })).json();
  const conversation = body.conversations.find((item) => item.agentId === TEST_AGENT_ID);
  assert.ok(conversation);
  assert.equal(conversation.turns.length, 2);
  assert.equal(conversation.turns[0].prompt, "HISTORY-ONE");
  assert.match(conversation.turns[0].finalReport, /HISTORY-ONE/);
  assert.match(conversation.turns[0].activity, /\[思考\] considering HISTORY-ONE/);
  assert.match(conversation.turns[0].activity, /\[工具 completed\] read/);
});

test("active conversations are serialized and cannot switch workspace", async (t) => {
  let bridge;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const waitingRunner = {
    mode: "test-agent",
    async execute(context) {
      await Promise.race([
        waiting,
        new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true })),
      ]);
      return { exitCode: context.signal.aborted ? 1 : 0, signal: null, metadata: { agentId: TEST_AGENT_ID } };
    },
  };
  bridge = await createTestBridge(undefined, {}, waitingRunner);
  t.after(async () => { release(); await bridge.close(); });

  const first = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify({
      workspace: bridge.workspace,
      prompt: "first active turn",
      agentId: TEST_AGENT_ID,
      timeoutSeconds: 20,
      idempotencyKey: "active-first",
    }),
  });
  assert.equal(first.status, 202);
  const replay = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify({
      workspace: bridge.workspace,
      prompt: "first active turn",
      agentId: TEST_AGENT_ID,
      timeoutSeconds: 20,
      idempotencyKey: "active-first",
    }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  const busy = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify({
      workspace: bridge.workspace,
      prompt: "second active turn",
      agentId: TEST_AGENT_ID,
      timeoutSeconds: 20,
      idempotencyKey: "active-second",
    }),
  });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, "conversation_busy");

  const firstJob = (await first.json()).job;
  await fetch(`${bridge.baseUrl}/v1/jobs/${firstJob.id}/cancel`, {
    method: "POST",
    headers: bridge.headers,
  });
  await waitForJob(bridge, firstJob.id);
  release();

  const otherWorkspace = path.join(bridge.workspace, "other");
  await mkdir(otherWorkspace, { recursive: true });
  const conflict = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify({
      workspace: otherWorkspace,
      prompt: "switch workspace",
      agentId: TEST_AGENT_ID,
      timeoutSeconds: 20,
      idempotencyKey: "workspace-conflict",
    }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "conversation_workspace_conflict");
});

test("job executes, streams events, and produces final.md", async (t) => {
  const bridge = await createTestBridge();
  t.after(() => bridge.close());
  const createResponse = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify({
      workspace: bridge.workspace,
      prompt: "verify streamed output",
      timeoutSeconds: 20,
      idempotencyKey: "stream-test",
    }),
  });
  assert.equal(createResponse.status, 202);
  const { job } = await createResponse.json();
  const finished = await waitForJob(bridge, job.id);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.artifacts, ["final.md"]);

  const events = await (await fetch(`${bridge.baseUrl}/v1/jobs/${job.id}/events`, {
    headers: bridge.headers,
  })).text();
  assert.match(events, /event: stdout/);
  assert.match(events, /event: done/);
  assert.match(events, /FAKE-CURSOR-OK/);

  const artifact = await (await fetch(
    `${bridge.baseUrl}/v1/jobs/${job.id}/artifacts/final.md`,
    { headers: bridge.headers },
  )).text();
  assert.match(artifact, /FAKE-CURSOR-OK/);
});

test("idempotency replays the same request and rejects a changed payload", async (t) => {
  const bridge = await createTestBridge();
  t.after(() => bridge.close());
  const firstPayload = {
    workspace: bridge.workspace,
    prompt: "same request",
    timeoutSeconds: 20,
    idempotencyKey: "same-key",
  };
  const first = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify(firstPayload),
  });
  const firstBody = await first.json();
  const replay = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify(firstPayload),
  });
  const replayBody = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.job.id, firstBody.job.id);

  const conflict = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify({ ...firstPayload, prompt: "different request" }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "idempotency_conflict");
});

test("workspace allowlist blocks paths outside configured roots", async (t) => {
  const bridge = await createTestBridge();
  t.after(() => bridge.close());
  const response = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify({
      workspace: "C:\\Windows",
      prompt: "attempt escape",
      timeoutSeconds: 20,
    }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "workspace_forbidden");
});

test("queued jobs can be cancelled", async (t) => {
  const bridge = await createTestBridge({
    mode: "command",
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 30000)"],
  });
  t.after(() => bridge.close());
  const create = async (key) =>
    (await (await fetch(`${bridge.baseUrl}/v1/jobs`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({
        workspace: bridge.workspace,
        prompt: key,
        timeoutSeconds: 20,
        idempotencyKey: key,
      }),
    })).json()).job;

  const running = await create("cancel-running");
  const queued = await create("cancel-queued");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const response = await fetch(`${bridge.baseUrl}/v1/jobs/${queued.id}/cancel`, {
    method: "POST",
    headers: bridge.headers,
  });
  assert.equal(response.status, 200);
  const queuedJob = await waitForJob(bridge, queued.id);
  assert.equal(queuedJob.status, "cancelled");

  await fetch(`${bridge.baseUrl}/v1/jobs/${running.id}/cancel`, {
    method: "POST",
    headers: bridge.headers,
  });
  const runningJob = await waitForJob(bridge, running.id);
  assert.equal(runningJob.status, "cancelled");
});

test("jobs time out and killed runners do not corrupt job state", async (t) => {
  const bridge = await createTestBridge({
    mode: "command",
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 30000)"],
  });
  t.after(() => bridge.close());
  const response = await fetch(`${bridge.baseUrl}/v1/jobs`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify({
      workspace: bridge.workspace,
      prompt: "timeout",
      timeoutSeconds: 5,
    }),
  });
  const { job } = await response.json();
  const finished = await waitForJob(bridge, job.id, 10000);
  assert.equal(finished.status, "timed_out");
});

test("workspace file browser previews text and enforces read-only safety boundaries", async (t) => {
  const bridge = await createTestBridge();
  t.after(() => bridge.close());
  await mkdir(path.join(bridge.workspace, "src"), { recursive: true });
  await writeFile(path.join(bridge.workspace, "src", "example.js"), "export const answer = 42;\r\n", "utf8");
  await writeFile(path.join(bridge.workspace, ".env"), "SECRET=must-not-leak\n", "utf8");
  await writeFile(path.join(bridge.workspace, "tool.exe"), Buffer.from([0x4d, 0x5a, 0x00, 0x00]));

  const filesUrl = (relativePath) =>
    bridge.baseUrl + "/v1/files?workspace=" + encodeURIComponent(bridge.workspace) +
    "&path=" + encodeURIComponent(relativePath);
  const fileUrl = (relativePath) =>
    bridge.baseUrl + "/v1/file?workspace=" + encodeURIComponent(bridge.workspace) +
    "&path=" + encodeURIComponent(relativePath);

  const rootResponse = await fetch(filesUrl(""), { headers: bridge.headers });
  assert.equal(rootResponse.status, 200);
  const root = await rootResponse.json();
  const envEntry = root.entries.find((entry) => entry.name === ".env");
  const exeEntry = root.entries.find((entry) => entry.name === "tool.exe");
  assert.equal(envEntry.previewable, false);
  assert.equal(envEntry.reason, "sensitive");
  assert.equal(exeEntry.previewable, false);
  assert.equal(exeEntry.reason, "executable");

  const nestedResponse = await fetch(filesUrl("src"), { headers: bridge.headers });
  assert.equal(nestedResponse.status, 200);
  assert.ok((await nestedResponse.json()).entries.some((entry) => entry.name === "example.js"));

  const fileResponse = await fetch(fileUrl("src/example.js"), { headers: bridge.headers });
  assert.equal(fileResponse.status, 200);
  const file = await fileResponse.json();
  assert.equal(file.language, "javascript");
  assert.match(file.content, /answer = 42/);

  const blockedEnv = await fetch(fileUrl(".env"), { headers: bridge.headers });
  assert.equal(blockedEnv.status, 403);
  assert.equal((await blockedEnv.json()).code, "sensitive_file");

  const blockedBinary = await fetch(fileUrl("tool.exe"), { headers: bridge.headers });
  assert.equal(blockedBinary.status, 415);
  assert.equal((await blockedBinary.json()).code, "binary_file");

  const traversal = await fetch(fileUrl("../../outside.txt"), { headers: bridge.headers });
  assert.equal(traversal.status, 403);
  assert.equal((await traversal.json()).code, "file_forbidden");

  const noToken = await fetch(bridge.baseUrl + "/v1/files?workspace=" + encodeURIComponent(bridge.workspace));
  assert.equal(noToken.status, 401);

  await writeFile(path.join(bridge.workspace, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
  const blockedArchive = await fetch(fileUrl("archive.zip"), { headers: bridge.headers });
  assert.equal(blockedArchive.status, 415);
  assert.equal((await blockedArchive.json()).code, "binary_file");

  await writeFile(path.join(bridge.workspace, "utf16.txt"), Buffer.from([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]));
  const utf16Response = await fetch(fileUrl("utf16.txt"), { headers: bridge.headers });
  assert.equal(utf16Response.status, 200);
  const utf16 = await utf16Response.json();
  assert.equal(utf16.encoding, "utf-16le");
  assert.equal(utf16.content, "Hi");
});
