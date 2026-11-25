import { timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";

export function nowIso() {
  return new Date().toISOString();
}

export function constantTimeTokenEquals(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function canonicalizeWorkspace(requestedWorkspace, allowedWorkspaces) {
  if (typeof requestedWorkspace !== "string" || requestedWorkspace.trim() === "") {
    throw new HttpError(400, "workspace is required", "invalid_workspace");
  }

  let requested;
  try {
    requested = await realpath(path.resolve(requestedWorkspace));
    if (!(await stat(requested)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new HttpError(400, "workspace does not exist or is not a directory", "invalid_workspace");
  }

  for (const configuredRoot of allowedWorkspaces) {
    let root;
    try {
      root = await realpath(path.resolve(configuredRoot));
    } catch {
      continue;
    }
    const candidate = process.platform === "win32" ? requested.toLowerCase() : requested;
    const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
    if (isInsideRoot(normalizedRoot, candidate)) {
      return requested;
    }
  }

  throw new HttpError(403, "workspace is outside the configured allowlist", "workspace_forbidden");
}

export function parseAuthorization(header) {
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export function sendJson(response, statusCode, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(encoded);
}

export function statusFromExitCode(code, signal) {
  return code === 0 && signal == null ? "succeeded" : "failed";
}

function modelSelectionFrom(input) {
  const model = typeof input === "string" ? { id: input } : input;
  if (
    model === null ||
    typeof model !== "object" ||
    Array.isArray(model) ||
    typeof model.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model.id.trim())
  ) {
    throw new HttpError(400, "model must be a valid Cursor model ID or selection", "invalid_model");
  }

  const params = model.params;
  if (
    params !== undefined &&
    (!Array.isArray(params) ||
      params.length > 16 ||
      params.some((param) =>
        param === null ||
        typeof param !== "object" ||
        typeof param.id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,64}$/.test(param.id) ||
        typeof param.value !== "string" ||
        !/^[^\u0000-\u001F]{1,128}$/.test(param.value)
      ))
  ) {
    throw new HttpError(400, "model.params must contain valid parameter entries", "invalid_model");
  }

  if (model.maxMode !== undefined && typeof model.maxMode !== "boolean") {
    throw new HttpError(400, "model.maxMode must be a boolean", "invalid_model");
  }

  return {
    id: model.id.trim(),
    ...(Array.isArray(params) && params.length > 0
      ? { params: params.map((param) => ({ id: param.id, value: param.value })) }
      : {}),
    ...(model.maxMode === undefined ? {} : { maxMode: model.maxMode }),
  };
}

export function validateJobRequest(input, config) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "request body must be a JSON object", "invalid_request");
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new HttpError(400, "prompt is required", "invalid_prompt");
  }
  if (Buffer.byteLength(input.prompt, "utf8") > 64 * 1024) {
    throw new HttpError(413, "prompt exceeds 64 KiB", "prompt_too_large");
  }

  const timeoutSeconds =
    input.timeoutSeconds === undefined
      ? config.defaultTimeoutSeconds
      : Number(input.timeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 24 * 60 * 60) {
    throw new HttpError(400, "timeoutSeconds must be between 5 and 86400", "invalid_timeout");
  }

  const idempotencyKey = input.idempotencyKey;
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== "string" ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 128)
  ) {
    throw new HttpError(400, "idempotencyKey must contain 1 to 128 characters", "invalid_idempotency_key");
  }

  const thread = input.thread;
  if (
    thread !== undefined &&
    (typeof thread !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread))
  ) {
    throw new HttpError(400, "thread must be a Cursor thread UUID", "invalid_thread");
  }

  const agentId = input.agentId;
  if (
    agentId !== undefined &&
    (typeof agentId !== "string" || !/^agent-[0-9a-f-]{36}$/i.test(agentId))
  ) {
    throw new HttpError(400, "agentId must be a Cursor local agent ID", "invalid_agent_id");
  }

  const model = input.model === undefined ? undefined : modelSelectionFrom(input.model);

  return {
    prompt: input.prompt,
    workspace: input.workspace,
    timeoutSeconds,
    idempotencyKey,
    thread,
    agentId,
    model,
  };
}
