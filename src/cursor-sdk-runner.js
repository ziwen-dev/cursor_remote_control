import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./config.js";

const ALLOWED_SETTING_SOURCES = new Set(["project", "user", "team", "mdm", "plugins", "all"]);
const PREVIEW_LIMIT = 4000;
const INITIAL_RETRY_DELAYS_MS = [500, 1500];
const RETRYABLE_INITIALIZATION_ERROR =
  /Route GET:\/v1\/models not found|model catalog|Network request failed|fetch failed|API key exchange|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error("job cancelled");
}

function preview(value) {
  if (value === undefined) {
    return "";
  }
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length <= PREVIEW_LIMIT) {
    return text;
  }
  return `${text.slice(0, PREVIEW_LIMIT)}... [truncated]`;
}

function resolveFromProject(filePath) {
  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(projectRoot, filePath);
}

function wait(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableInitializationError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const cause = error.cause instanceof Error ? ` ${error.cause.message}` : "";
  return RETRYABLE_INITIALIZATION_ERROR.test(`${error.message}${cause}`);
}

async function retryInitialization(task, options = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const delay = INITIAL_RETRY_DELAYS_MS[attempt];
      if (
        delay === undefined ||
        options.signal?.aborted ||
        !isRetryableInitializationError(error)
      ) {
        throw error;
      }
      options.onRetry?.({
        attempt: attempt + 1,
        delay,
        error,
      });
      await wait(delay, options.signal);
    }
  }
}

export async function loadCursorApiKey(config) {
  const environmentKey = process.env.CURSOR_API_KEY?.trim();
  if (environmentKey) {
    return environmentKey;
  }

  const configuredPath = config.apiKeyFile ?? "data/cursor-api-key.txt";
  if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
    throw new Error("cursor-sdk runner requires runner.apiKeyFile or CURSOR_API_KEY");
  }

  const apiKeyPath = resolveFromProject(configuredPath);
  let key;
  try {
    key = (await readFile(apiKeyPath, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (config.allowStoredAuth !== false) {
        return undefined;
      }
      throw new Error(`Cursor API key is not configured: ${apiKeyPath}`);
    }
    throw error;
  }
  if (!key) {
    throw new Error(`Cursor API key file is empty: ${apiKeyPath}`);
  }
  return key;
}

export async function listCursorModels(config, dependencies = {}) {
  const apiKey = await loadCursorApiKey(config);
  const sdk = dependencies.sdk ?? await import("@cursor/sdk");
  if (typeof sdk.Cursor?.models?.list !== "function") {
    throw new Error("The installed @cursor/sdk package does not expose Cursor.models.list");
  }
  return retryInitialization(
    () => sdk.Cursor.models.list(apiKey ? { apiKey } : undefined),
  );
}

function modelSelection(value) {
  if (typeof value === "string" && value.trim()) {
    return { id: value.trim() };
  }
  if (value && typeof value === "object" && typeof value.id === "string" && value.id.trim()) {
    return { ...value, id: value.id.trim() };
  }
  throw new Error("cursor-sdk runner requires runner.model, for example \"composer-2\"");
}

function publicModelSelection(value) {
  const selection = modelSelection(value);
  return {
    id: selection.id,
    ...(Array.isArray(selection.params) && selection.params.length > 0
      ? { params: selection.params.map((param) => ({ id: param.id, value: param.value })) }
      : {}),
    ...(selection.maxMode === undefined ? {} : { maxMode: selection.maxMode }),
  };
}

function localOptions(config, workspace) {
  const settingSources = config.settingSources ?? [];
  if (!Array.isArray(settingSources)) {
    throw new Error("runner.settingSources must be an array");
  }
  for (const source of settingSources) {
    if (!ALLOWED_SETTING_SOURCES.has(source)) {
      throw new Error(`Unsupported Cursor setting source: ${source}`);
    }
  }

  const local = {
    cwd: workspace,
    settingSources,
  };
  if (config.autoReview !== undefined) {
    local.autoReview = Boolean(config.autoReview);
  }
  if (config.enableAgentRetries !== undefined) {
    local.enableAgentRetries = Boolean(config.enableAgentRetries);
  }
  if (Array.isArray(config.dirs) && config.dirs.length > 0) {
    local.dirs = config.dirs.map((entry) => {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new Error("runner.dirs must contain non-empty paths");
      }
      return path.resolve(entry);
    });
  }
  if (config.sandboxOptions !== undefined) {
    if (typeof config.sandboxOptions?.enabled !== "boolean") {
      throw new Error("runner.sandboxOptions.enabled must be a boolean");
    }
    local.sandboxOptions = { enabled: config.sandboxOptions.enabled };
  }
  return local;
}

function emitCursorEvent(message, context, assistantText) {
  switch (message.type) {
    case "assistant": {
      for (const block of message.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          assistantText.push(block.text);
        }
      }
      break;
    }
    case "tool_call": {
      context.onEvent({
        kind: "tool",
        status: message.status,
        name: message.name,
        args: message.args === undefined ? undefined : preview(message.args),
        result: message.result === undefined ? undefined : preview(message.result),
      });
      break;
    }
    case "thinking":
      context.onEvent({
        kind: "thinking",
        text: message.text ?? "",
      });
      break;
    case "status": {
      const suffix = message.message ? ` ${message.message}` : "";
      context.onEvent({
        kind: "status",
        status: message.status,
        text: suffix.trim(),
      });
      break;
    }
    case "task": {
      context.onEvent({ kind: "task", status: message.status, text: message.text ?? "" });
      break;
    }
    case "summary": {
      context.onEvent({
        kind: "summary",
        status: message.status,
        fallback: Boolean(message.fallback),
        text: message.text ?? "",
      });
      break;
    }
    case "usage": {
      context.onEvent({ kind: "usage", usage: message.usage });
      break;
    }
    case "system": {
      context.onEvent({
        kind: "system",
        agentId: message.agent_id,
        runId: message.run_id,
        model: message.model?.id,
      });
      break;
    }
    default:
      break;
  }
}

function errorReport(title, details) {
  const lines = [`# ${title}`, ""];
  if (details?.code) {
    lines.push(`- Code: \`${details.code}\``);
  }
  if (details?.message) {
    lines.push(`- Error: ${details.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function errorDiagnostic(error) {
  const lines = [];
  let current = error;
  let depth = 0;
  while (current && depth < 4) {
    const prefix = depth === 0 ? "[cursor] initialization error" : "[cursor] caused by";
    lines.push(`${prefix}: ${errorMessage(current)}`);
    if (current.name) {
      lines.push(`[cursor] name: ${current.name}`);
    }
    if (current.code) {
      lines.push(`[cursor] code: ${current.code}`);
    }
    current = current.cause;
    depth += 1;
  }
  const stack = error instanceof Error && error.stack ? error.stack : "";
  if (stack) {
    lines.push("[cursor] stack:", stack.slice(0, 4000));
  }
  return `${lines.join("\n")}\n`;
}

export async function runCursorSdkRunner(config, context, dependencies = {}) {
  const promptPath = path.join(context.outputDir, "prompt.txt");
  await writeFile(promptPath, context.prompt, "utf8");

  const apiKey = await loadCursorApiKey(config);
  const model = modelSelection(context.model ?? config.model);
  const local = localOptions(config, context.workspace);
  const sdk = dependencies.sdk ?? await import("@cursor/sdk");
  if (typeof sdk.Agent?.create !== "function") {
    throw new Error("The installed @cursor/sdk package does not expose Agent.create");
  }
  if (context.signal.aborted) {
    throw abortError(context.signal);
  }

  if (!apiKey && sdk.Cursor?.models?.list) {
    try {
      await retryInitialization(
        () => sdk.Cursor.models.list(),
        {
          signal: context.signal,
          onRetry: ({ attempt, delay, error }) => {
            context.onStderr(
              `[cursor] model catalog request failed (attempt ${attempt}, retrying in ${delay}ms): ${errorMessage(error)}\n`,
            );
          },
        },
      );
    } catch (error) {
      context.onStderr(errorDiagnostic(error));
      throw new Error(
        `Cursor 模型目录连接失败：${errorMessage(error)}. ` +
        "请确认 Cursor SDK 已登录且本机能访问 https://api2.cursor.sh。",
        { cause: error },
      );
    }
  }
  if (context.agentId && !context.recoverAgent && sdk.Agent.listRuns) {
    let previous;
    try {
      previous = await sdk.Agent.listRuns(context.agentId, {
        runtime: "local",
        cwd: context.workspace,
        limit: 1,
      });
    } catch {
      previous = null;
    }
    if (previous && previous.items?.length === 0) {
      throw new Error(`找不到会话 ${context.agentId} 的本地记录，旧会话可能已被 Cursor 清理。`);
    }
  }
  if (!apiKey) {
    const authStatus = await sdk.Cursor?.auth?.status?.();
    if (authStatus?.status !== "logged-in") {
      throw new Error(
        "Cursor SDK is not authenticated. Run npm run cursor-login, or set CURSOR_API_KEY / data/cursor-api-key.txt.",
      );
    }
  }

  let agent;
  let run;
  let cancellation;
  let interruption;
  let executionError;
  const assistantText = [];

  const cancelRun = () => {
    if (!run || cancellation) {
      return cancellation ?? Promise.resolve();
    }
    cancellation = Promise.resolve().then(async () => {
      if (typeof run.cancel !== "function") {
        throw new Error("Cursor run does not support cancellation");
      }
      await run.cancel();
    }).catch((error) => {
      context.onStderr(`[cursor] cancel failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    return cancellation;
  };

  const abortHandler = () => {
    void cancelRun();
  };

  try {
    const agentOptions = {
      ...(apiKey ? { apiKey } : {}),
      model,
      local,
      ...(Array.isArray(config.tools) ? { tools: config.tools } : {}),
      ...(Array.isArray(config.disallowedTools) ? { disallowedTools: config.disallowedTools } : {}),
    };
    agent = await retryInitialization(
      () => context.agentId
        ? sdk.Agent.resume(context.agentId, agentOptions)
        : sdk.Agent.create({
            ...agentOptions,
            name: `Cursor Remote Bridge ${context.job.id}`,
          }),
      {
        signal: context.signal,
        onRetry: ({ attempt, delay, error }) => {
          context.onStderr(
            `[cursor] ${context.agentId ? "agent resume" : "agent create"} failed ` +
            `(attempt ${attempt}, retrying in ${delay}ms): ${errorMessage(error)}\n`,
          );
        },
      },
    );
    if (context.signal.aborted) {
      const error = abortError(context.signal);
      context.onStderr(`[cursor] ${error.message}\n`);
      throw error;
    }

    context.onStdout(
      `[cursor] ${context.agentId ? "resuming" : "starting"} local agent ${agent.agentId} in ${context.workspace}\n`,
    );
    run = await agent.send(context.prompt, {
      model,
      idempotencyKey: context.job.idempotencyKey ?? context.job.id,
    });
    const registerInterrupt = context.onInterrupt ?? (() => {});
    registerInterrupt(async (message) => {
      if (!run || run.status !== "running" || typeof run.steer !== "function") {
        return { accepted: false, reason: "run_not_active" };
      }
      if (interruption) return interruption;
      interruption = Promise.resolve().then(async () => {
        const outcome = await run.steer(message);
        context.onEvent({
          kind: "status",
          status: "INTERRUPT",
          text: outcome === "complete_delivered" ? "当前任务已接收新指令" : "新指令已排队",
        });
        return { accepted: true, outcome: typeof outcome === "string" ? outcome : "queued" };
      }).finally(() => {
        interruption = undefined;
      });
      return interruption;
    });
    context.signal.addEventListener("abort", abortHandler, { once: true });
    if (context.signal.aborted) {
      await cancelRun();
    }
    context.onStdout(`[cursor] run ${run.id}\n`);
    context.onEvent({ kind: "run", runId: run.id, agentId: run.agentId });

    for await (const message of run.stream()) {
      emitCursorEvent(message, context, assistantText);
    }
    if (context.signal.aborted) {
      await cancelRun();
    }

    const result = await run.wait();
    const metadata = {
      agentId: result.id === run.id ? run.agentId : run.agentId,
      runId: result.id,
      requestId: result.requestId,
      model: publicModelSelection(result.model ?? run.model ?? model),
      durationMs: result.durationMs,
      usage: result.usage,
      cursorStatus: result.status,
    };

    const fallbackText = assistantText.join("\n\n").trim();
    const finalText = result.result?.trim() || fallbackText;
    if (result.status === "finished" && finalText) {
      await writeFile(path.join(context.outputDir, "final.md"), `${finalText}\n`, "utf8");
      return { exitCode: 0, signal: null, metadata };
    }

    if (result.status === "finished") {
      const message = "Cursor finished without returning a final text response";
      await writeFile(path.join(context.outputDir, "final.md"), errorReport("Cursor task failed", { message }));
      return { exitCode: 1, signal: null, error: message, metadata };
    }

    const message = result.error?.message ?? `Cursor run ended with status ${result.status}`;
    const userFacingMessage = /API key exchange|fetch failed|ECONN|ETIMEDOUT|socket/i.test(message)
      ? `Cursor 网络连接失败：${message}\n\n请确认本机能访问 https://api2.cursor.sh，然后重新发送。如果频繁出现，请检查系统代理、VPN 和 DNS。`
      : message;
    await writeFile(
      path.join(context.outputDir, "final.md"),
      errorReport(result.status === "cancelled" ? "Cursor task cancelled" : "Cursor task failed", {
        code: result.error?.code,
        message: userFacingMessage,
      }),
    );
    return {
      exitCode: 1,
      signal: null,
      error: message,
      metadata,
    };
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    context.signal.removeEventListener("abort", abortHandler);
    try {
      if (context.signal.aborted && run?.status === "running") {
        await cancelRun();
      }
      if (agent) {
        if (typeof agent[Symbol.asyncDispose] === "function") {
          await agent[Symbol.asyncDispose]();
        } else if (typeof agent.close === "function") {
          agent.close();
        }
      }
    } catch (cleanupError) {
      if (executionError) {
        context.onStderr(
          `[cursor] cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
        );
      } else {
        throw cleanupError;
      }
    }
  }
}
