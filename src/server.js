import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, projectRoot } from "./config.js";
import { HttpError } from "./errors.js";
import { JobManager } from "./job-manager.js";
import { createRunner } from "./runner.js";
import { listCursorModels } from "./cursor-sdk-runner.js";
import { listWorkspaceFiles, readWorkspaceFile } from "./workspace-files.js";
import {
  canonicalizeWorkspace,
  constantTimeTokenEquals,
  nowIso,
  parseAuthorization,
  sendJson,
  validateJobRequest,
} from "./utils.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    workspace: job.workspace,
    runner: job.runner,
    thread: job.thread,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    error: job.error,
    timeoutSeconds: job.timeoutSeconds,
    prompt: job.prompt,
    agentId: job.agentId,
    model: job.model,
    metadata: job.metadata,
    artifacts: job.artifacts,
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "request body exceeds 1 MiB", "request_too_large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw new HttpError(400, "request body is required", "invalid_request");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be valid JSON", "invalid_json");
  }
}

function authorized(request, config) {
  return constantTimeTokenEquals(parseAuthorization(request.headers.authorization), config.apiToken);
}

async function serveIndex(response, config) {
  const index = await readFile(path.join(config.publicDir, "workbench.html"));
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": index.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  });
  response.end(index);
}

async function serveJavaScript(response, config, filename) {
  const file = await readFile(path.join(config.publicDir, filename));
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": file.length,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(file);
}

async function serveVendor(response, filename) {
  const allowed = new Map([
    ["marked.min.js", "marked/lib/marked.umd.js"],
    ["purify.min.js", "dompurify/dist/purify.min.js"],
  ]);
  const relative = allowed.get(filename);
  if (!relative) {
    throw new HttpError(404, "not found", "not_found");
  }
  const file = await readFile(path.join(projectRoot, "node_modules", relative));
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": file.length,
    "cache-control": "public, max-age=86400, immutable",
    "x-content-type-options": "nosniff",
  });
  response.end(file);
}

async function listWorkspaceDirectories(requestedPath) {
  let directory;
  let entries;
  if (!requestedPath) {
    directory = "";
    entries = process.platform === "win32"
      ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`)
      : [path.parse(projectRoot).root];
  } else {
    try {
      directory = await realpath(path.resolve(requestedPath));
      entries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(directory, entry.name));
    } catch {
      throw new HttpError(400, "folder does not exist or cannot be read", "invalid_workspace_folder");
    }
  }
  const candidates = [];
  for (const candidatePath of entries) {
    try {
      if ((await stat(candidatePath)).isDirectory()) {
        candidates.push({ path: candidatePath, name: path.basename(candidatePath) || candidatePath });
      }
    } catch {
      // Inaccessible drives and links are omitted from the picker.
    }
  }
  candidates.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const parent = directory ? path.dirname(directory) : null;
  return { path: directory, parent: parent && parent !== directory ? parent : null, entries: candidates };
}

function sameWorkspace(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function persistAllowedWorkspaces(config, allowedWorkspaces, temporaryPath) {
  const configured = JSON.parse(await readFile(config.configPath, "utf8"));
  configured.allowedWorkspaces = allowedWorkspaces;
  await writeFile(temporaryPath, `${JSON.stringify(configured, null, 2)}\n`, "utf8");
  await rename(temporaryPath, config.configPath);
}

async function addAllowedWorkspace(config, requestedPath) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    throw new HttpError(400, "workspace is required", "invalid_workspace");
  }
  let selected;
  try {
    selected = await realpath(path.resolve(requestedPath.trim()));
    if (!(await stat(selected)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new HttpError(400, "workspace does not exist or is not a directory", "invalid_workspace");
  }
  if (!config.allowedWorkspaces.some((entry) => sameWorkspace(entry, selected))) {
    const updated = [...config.allowedWorkspaces, selected];
    const temporaryPath = `${config.configPath}.${process.pid}.workspace.tmp`;
    await persistAllowedWorkspaces(config, updated, temporaryPath);
    config.allowedWorkspaces = updated;
  }
  return selected;
}

async function removeAllowedWorkspace(config, requestedPath) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    throw new HttpError(400, "workspace is required", "invalid_workspace");
  }
  const existing = config.allowedWorkspaces.find((entry) => sameWorkspace(entry, requestedPath));
  if (!existing) {
    throw new HttpError(404, "workspace is not in the allowlist", "workspace_not_found");
  }
  if (config.allowedWorkspaces.length === 1) {
    throw new HttpError(409, "at least one workspace must remain", "last_workspace");
  }
  const updated = config.allowedWorkspaces.filter((entry) => !sameWorkspace(entry, existing));
  const temporaryPath = `${config.configPath}.${process.pid}.workspace.tmp`;
  await persistAllowedWorkspaces(config, updated, temporaryPath);
  config.allowedWorkspaces = updated;
  return existing;
}

function isLoopbackHostHeader(request) {
  const host = request.headers.host?.toLowerCase().replace(/^\[|\](:\d+)?$/g, "").replace(/:\d+$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLocalOrAuthorized(request, config) {
  return isLoopbackHostHeader(request) || authorized(request, config);
}

function writeEvent(response, event) {
  response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function serveEvents(request, response, manager, jobId) {
  const lastEventId = request.headers["last-event-id"];
  const url = new URL(request.url, "http://bridge.local");
  const after = Number(lastEventId ?? url.searchParams.get("after") ?? 0);
  const safeAfter = Number.isInteger(after) && after >= 0 ? after : 0;

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders?.();
  response.write(": connected\n\n");

  let ready = false;
  let closed = false;
  let highestSequence = safeAfter;
  const pending = [];

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    response.end();
  };

  const write = (event) => {
    if (closed || event.seq <= highestSequence) {
      return;
    }
    highestSequence = event.seq;
    writeEvent(response, event);
    if (event.type === "done") {
      close();
    }
  };

  const unsubscribe = manager.subscribe(jobId, (event) => {
    if (ready) {
      write(event);
    } else {
      pending.push(event);
    }
  });
  const heartbeat = setInterval(() => {
    if (!closed) {
      response.write(`: heartbeat ${Date.now()}\n\n`);
    }
  }, 15000);
  heartbeat.unref?.();

  request.once("close", close);

  try {
    const replay = await manager.eventsAfter(jobId, safeAfter);
    for (const event of replay) {
      write(event);
      if (closed) {
        return;
      }
    }
    ready = true;
    for (const event of pending) {
      write(event);
      if (closed) {
        return;
      }
    }
    const job = manager.getJob(jobId);
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(job.status)) {
      close();
    }
  } catch (error) {
    if (!closed) {
      writeEvent(response, {
        seq: highestSequence + 1,
        timestamp: nowIso(),
        type: "stream_error",
        message: error instanceof Error ? error.message : String(error),
      });
      close();
    }
  }
}

async function route(request, response, config, manager) {
  const url = new URL(request.url, "http://bridge.local");
  const { pathname } = url;

  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    await serveIndex(response, config);
    return;
  }
  if (request.method === "GET" && pathname === "/app.js") {
    await serveJavaScript(response, config, "workbench.js");
    return;
  }
  if (request.method === "GET" && pathname === "/theme-init.js") {
    await serveJavaScript(response, config, "theme-init.js");
    return;
  }
  if (request.method === "GET" && pathname === "/vendor/marked.min.js") {
    await serveVendor(response, "marked.min.js");
    return;
  }
  if (request.method === "GET" && pathname === "/vendor/purify.min.js") {
    await serveVendor(response, "purify.min.js");
    return;
  }
  if (request.method === "GET" && pathname === "/local-token") {
    if (!isLoopbackHostHeader(request)) {
      throw new HttpError(404, "not found", "not_found");
    }
    sendJson(response, 200, { token: config.apiToken, local: true });
    return;
  }
  if (request.method === "GET" && pathname === "/local-workspace-browse") {
    if (!isLocalOrAuthorized(request, config)) {
      throw new HttpError(401, "unauthorized", "unauthorized");
    }
    const browsePath = url.searchParams.get("path")?.trim() || "";
    sendJson(response, 200, await listWorkspaceDirectories(browsePath));
    return;
  }
  if (request.method === "POST" && pathname === "/local-workspaces") {
    if (!isLocalOrAuthorized(request, config)) {
      throw new HttpError(401, "unauthorized", "unauthorized");
    }
    const body = await readJsonBody(request);
    const workspacePathValue = await addAllowedWorkspace(config, body.path);
    sendJson(response, 200, { workspace: workspacePathValue, allowedWorkspaces: config.allowedWorkspaces });
    return;
  }
  if (request.method === "DELETE" && pathname === "/local-workspaces") {
    if (!isLocalOrAuthorized(request, config)) {
      throw new HttpError(401, "unauthorized", "unauthorized");
    }
    const body = await readJsonBody(request);
    manager.beginWorkspaceRemoval(body.path);
    let removed;
    let removedJobs;
    try {
      removed = await removeAllowedWorkspace(config, body.path);
      removedJobs = await manager.removeWorkspaceHistory(removed);
      sendJson(response, 200, { removed, removedJobs, allowedWorkspaces: config.allowedWorkspaces });
    } finally {
      manager.endWorkspaceRemoval(body.path);
    }
    return;
  }
  if (request.method === "GET" && pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "cursor-remote-bridge",
      runner: manager.runner.mode,
      timestamp: nowIso(),
    });
    return;
  }

  if (!pathname.startsWith("/v1/")) {
    throw new HttpError(404, "not found", "not_found");
  }
  if (!authorized(request, config)) {
    throw new HttpError(401, "unauthorized", "unauthorized");
  }

  if (request.method === "GET" && pathname === "/v1/meta") {
    sendJson(response, 200, {
      service: "cursor-remote-bridge",
      runner: manager.runner.mode,
      allowedWorkspaces: config.allowedWorkspaces,
      maxConcurrentJobs: config.maxConcurrentJobs,
      maxQueuedJobs: config.maxQueuedJobs,
      defaultTimeoutSeconds: config.defaultTimeoutSeconds,
      model: config.runner?.mode === "cursor-sdk" ? config.runner.model : undefined,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/v1/files") {
    const requestedWorkspace = url.searchParams.get("workspace") ?? config.allowedWorkspaces[0];
    const workspacePath = await canonicalizeWorkspace(requestedWorkspace, config.allowedWorkspaces);
    const relativePath = url.searchParams.get("path") ?? "";
    sendJson(response, 200, await listWorkspaceFiles(workspacePath, relativePath));
    return;
  }

  if (request.method === "GET" && pathname === "/v1/file") {
    const requestedWorkspace = url.searchParams.get("workspace") ?? config.allowedWorkspaces[0];
    const workspacePath = await canonicalizeWorkspace(requestedWorkspace, config.allowedWorkspaces);
    const relativePath = url.searchParams.get("path") ?? "";
    sendJson(response, 200, await readWorkspaceFile(workspacePath, relativePath));
    return;
  }

  if (request.method === "GET" && pathname === "/v1/models") {
    if (config.runner?.mode !== "cursor-sdk") {
      throw new HttpError(409, "model catalog is only available in cursor-sdk mode", "model_catalog_unavailable");
    }
    try {
      const models = await listCursorModels(config.runner);
      sendJson(response, 200, {
        models,
        selectedModel: config.runner.model ?? null,
      });
    } catch (error) {
      throw new HttpError(
        502,
        `无法读取 Cursor 模型列表：${error instanceof Error ? error.message : String(error)}`,
        "model_catalog_unavailable",
      );
    }
    return;
  }

  if (request.method === "GET" && pathname === "/v1/conversations") {
    sendJson(response, 200, { conversations: manager.listConversations(50) });
    return;
  }

  if (request.method === "GET" && pathname === "/v1/jobs") {
    sendJson(response, 200, { jobs: manager.listJobs(50).map(publicJob) });
    return;
  }

  if (request.method === "POST" && pathname === "/v1/jobs") {
    const body = await readJsonBody(request);
    const input = validateJobRequest(body, config);
    const requestedWorkspace = body.workspace ?? config.allowedWorkspaces[0];
    input.workspace = await canonicalizeWorkspace(requestedWorkspace, config.allowedWorkspaces);
    const { job, replayed } = await manager.createJob(input);
    response.setHeader("location", `/v1/jobs/${job.id}`);
    sendJson(response, replayed ? 200 : 202, { job: publicJob(job), replayed });
    return;
  }

  const jobMatch = /^\/v1\/jobs\/([0-9a-f-]{36})(?:\/(events|cancel|interrupt|artifacts\/([^/]+)))?$/i.exec(pathname);
  if (!jobMatch) {
    throw new HttpError(404, "not found", "not_found");
  }
  const jobId = jobMatch[1];
  const action = jobMatch[2];
  const artifactName = jobMatch[3] ? decodeURIComponent(jobMatch[3]) : undefined;

  if (!action && request.method === "GET") {
    sendJson(response, 200, { job: publicJob(manager.getJob(jobId)) });
    return;
  }
  if (action === "cancel" && request.method === "POST") {
    const job = await manager.cancelJob(jobId);
    sendJson(response, 200, { job: publicJob(job) });
    return;
  }
  if (action === "interrupt" && request.method === "POST") {
    const body = await readJsonBody(request);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      throw new HttpError(400, "message is required", "invalid_interrupt");
    }
    if (Buffer.byteLength(message, "utf8") > 16 * 1024) {
      throw new HttpError(413, "message exceeds 16 KiB", "interrupt_too_large");
    }
    const job = await manager.interruptJob(jobId, message);
    sendJson(response, 202, { job: publicJob(job) });
    return;
  }
  if (action === "events" && request.method === "GET") {
    await serveEvents(request, response, manager, jobId);
    return;
  }
  if (action?.startsWith("artifacts/") && request.method === "GET") {
    const artifact = await manager.readArtifact(jobId, artifactName);
    const contentType =
      artifactName.endsWith(".md") ? "text/markdown; charset=utf-8" :
      artifactName.endsWith(".diff") ? "text/x-diff; charset=utf-8" :
      "text/plain; charset=utf-8";
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": artifact.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(artifact);
    return;
  }
  throw new HttpError(405, "method not allowed", "method_not_allowed");
}

export async function createBridgeServer({ config, runner } = {}) {
  const resolvedConfig = config ?? (await loadConfig());
  const resolvedRunner = runner ?? createRunner(resolvedConfig.runner);
  const manager = new JobManager({ config: resolvedConfig, runner: resolvedRunner });
  manager.runner = resolvedRunner;
  await manager.init();

  const server = createHttpServer((request, response) => {
    response.setHeader("x-request-id", randomUUID());
    route(request, response, resolvedConfig, manager).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, { error: error.message, code: error.code });
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: "internal server error", code: "internal_error" });
    });
  });
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 30 * 1000;
  return { server, manager, config: resolvedConfig, runner: resolvedRunner };
}

export async function startBridge() {
  const { server, config, runner, manager } = await createBridgeServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`Cursor Remote Bridge listening on http://${config.host}:${config.port}`);
  console.log(`Runner mode: ${runner.mode}`);
  console.log(`Allowed workspaces: ${config.allowedWorkspaces.join(", ")}`);
  if (!process.env.BRIDGE_API_TOKEN) {
    console.log(`Local API token file: ${config.tokenFile}`);
  }
  return { server, config, runner, manager };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(projectRoot, "src", "server.js")) {
  const running = await startBridge();
  const shutdown = () => running.server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
