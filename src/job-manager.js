import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import { JobStore } from "./job-store.js";
import { captureGitSnapshot } from "./runner.js";
import { nowIso } from "./utils.js";

function fingerprint(input) {
  return createHash("sha256")
    .update(JSON.stringify({
      prompt: input.prompt,
      workspace: input.workspace,
      timeoutSeconds: input.timeoutSeconds,
      thread: input.thread ?? null,
      agentId: input.agentId ?? null,
      model: input.model ?? null,
    }))
    .digest("hex");
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function initializationDiagnostic(error) {
  const lines = [];
  let current = error;
  let depth = 0;
  while (current && depth < 4) {
    const prefix = depth === 0 ? "[bridge] job initialization failed" : "[bridge] caused by";
    lines.push(`${prefix}: ${safeErrorMessage(current)}`);
    if (current.name) lines.push(`[bridge] name: ${current.name}`);
    if (current.code) lines.push(`[bridge] code: ${current.code}`);
    const inheritedCause = current.cause;
    if (!(inheritedCause instanceof Error)) break;
    current = inheritedCause;
    depth += 1;
  }
  return `${lines.join("\n")}\n`;
}

function detailText(value) {
  if (value === undefined) {
    return "";
  }
  try {
    return ` ${typeof value === "string" ? value : JSON.stringify(value)}`;
  } catch {
    return ` ${String(value)}`;
  }
}

function readableActivity(event) {
  if (event.type === "stdout") {
    return event.text ?? "";
  }
  if (event.type === "stderr") {
    return `[stderr] ${event.text ?? ""}\n`;
  }
  if (event.type !== "activity") {
    return "";
  }
  if (event.kind === "thinking") {
    return `[思考] ${event.text ?? ""}\n`;
  }
  if (event.kind === "status") {
    return `[状态] ${event.status ?? ""}${event.text ? ` ${event.text}` : ""}\n`;
  }
  if (event.kind === "tool") {
    return `[工具 ${event.status ?? ""}] ${event.name ?? ""}${detailText(event.args)}${event.result === undefined ? "" : ` ->${detailText(event.result)}`}\n`;
  }
  if (event.kind === "task") {
    return `[任务 ${event.status ?? ""}] ${event.text ?? ""}\n`;
  }
  if (event.kind === "summary") {
    const fallback = event.fallback ? " [fallback]" : "";
    return `[汇总 ${event.status ?? ""}]${fallback} ${event.text ?? ""}\n`;
  }
  if (event.kind === "usage") {
    return `[用量]${detailText(event.usage)}\n`;
  }
  if (event.kind === "run") {
    return `[运行] agent=${event.agentId ?? ""} run=${event.runId ?? ""}\n`;
  }
  if (event.kind === "system") {
    return `[连接] agent=${event.agentId ?? ""} run=${event.runId ?? ""}${event.model ? ` model=${event.model}` : ""}\n`;
  }
  if (event.kind === "assistant") {
    return "";
  }
  return `[活动] ${JSON.stringify(event)}\n`;
}

function appendActivityText(job, text) {
  if (!text) {
    return;
  }
  job.activityText = `${job.activityText ?? ""}${text}`;
}

function workspaceKey(workspacePath) {
  const resolved = path.resolve(workspacePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function writeFileIfMissing(filePath, data) {
  try {
    await writeFile(filePath, data, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
}

export class JobManager {
  constructor({ config, runner }) {
    this.config = config;
    this.runner = runner;
    this.store = new JobStore(config.dataDir);
    this.jobs = new Map();
    this.pendingInputs = new Map();
    this.controllers = new Map();
    this.finished = new Set();
    this.eventEmitter = new EventEmitter();
    this.eventEmitter.setMaxListeners(200);
    this.activeCount = 0;
    this.eventWriteChains = new Map();
    this.workspaceRemovals = new Set();
    this.interruptHandlers = new Map();
  }

  async init() {
    const storedJobs = await this.store.init();
    for (const storedJob of storedJobs) {
      const job = { ...storedJob };
      if (typeof job.prompt !== "string") {
        const request = await this.store.readRequest(job.id);
        job.prompt = typeof request?.prompt === "string" ? request.prompt : "";
      }
      if (!("finalReport" in job)) {
        try {
          job.finalReport = await readFile(path.join(this.store.jobDirectory(job.id), "final.md"), "utf8");
        } catch {
          job.finalReport = null;
        }
      }
      if (typeof job.activityText !== "string" || !job.activityText) {
        try {
          const events = (await readFile(this.store.eventsPath(job.id), "utf8"))
            .split("\n")
            .filter(Boolean)
            .flatMap((line) => {
              try {
                return [JSON.parse(line)];
              } catch {
                return [];
              }
            });
          job.activityText = events.map(readableActivity).join("");
        } catch {
          job.activityText = "";
        }
      }
      if (["queued", "running"].includes(job.status)) {
        job.status = "failed";
        job.error = "Bridge restarted before the job completed. Submit the task again.";
        job.finishedAt = nowIso();
      }
      this.jobs.set(job.id, job);
      if (["succeeded", "failed", "cancelled", "timed_out"].includes(job.status)) {
        this.finished.add(job.id);
      }
    }
    await this.#persist();
  }

  async #persist() {
    await this.store.persist([...this.jobs.values()]);
  }

  #jobOrThrow(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new HttpError(404, "job not found", "job_not_found");
    }
    return job;
  }

  getJob(jobId) {
    return this.#jobOrThrow(jobId);
  }

  listJobs(limit = 50) {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  findByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) {
      return undefined;
    }
    return [...this.jobs.values()].find((job) => job.idempotencyKey === idempotencyKey);
  }

  listConversations(limit = 50) {
    const groups = new Map();
    for (const job of this.jobs.values()) {
      const conversationId = job.agentId ?? `standalone-${job.id}`;
      const turn = {
        id: job.id,
        prompt: job.prompt ?? "",
        status: job.status,
        finalReport: job.finalReport ?? null,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        error: job.error,
        activity: job.activityText ?? "",
        artifacts: job.artifacts ?? [],
        metadata: job.metadata ?? {},
        model: job.model ?? null,
      };
      const existing = groups.get(conversationId);
      if (existing) {
        existing.turns.push(turn);
      } else {
        groups.set(conversationId, {
          id: conversationId,
          agentId: job.agentId ?? null,
          title: (job.prompt ?? "新对话").trim().split(/\r?\n/)[0].slice(0, 80),
          workspace: job.workspace,
          createdAt: job.createdAt,
          updatedAt: job.finishedAt ?? job.createdAt,
          turns: [turn],
        });
      }
    }
    return [...groups.values()]
      .map((group) => {
        group.turns.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        const latest = group.turns[group.turns.length - 1];
        group.updatedAt = latest.finishedAt ?? latest.createdAt;
        return group;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  beginWorkspaceRemoval(workspacePath) {
    const key = workspaceKey(workspacePath);
    if (this.workspaceRemovals.has(key)) {
      throw new HttpError(409, "workspace removal is already in progress", "workspace_busy");
    }
    const matching = [...this.jobs.values()].filter((job) => workspaceKey(job.workspace) === key);
    const active = matching.find((job) => ["queued", "running"].includes(job.status));
    if (active) {
      throw new HttpError(409, "workspace has an active conversation", "workspace_busy");
    }
    this.workspaceRemovals.add(key);
    return key;
  }

  endWorkspaceRemoval(workspacePath) {
    this.workspaceRemovals.delete(workspaceKey(workspacePath));
  }

  async removeWorkspaceHistory(workspacePath) {
    const key = workspaceKey(workspacePath);
    const ownsRemoval = !this.workspaceRemovals.has(key);
    if (ownsRemoval) {
      this.beginWorkspaceRemoval(workspacePath);
    }
    try {
      const matching = [...this.jobs.values()].filter((job) => workspaceKey(job.workspace) === key);
      const removedIds = new Set(matching.map((job) => job.id));
      await Promise.all(
        matching.map((job) => this.eventWriteChains.get(job.id)).filter(Boolean),
      );
      for (const jobId of removedIds) {
        this.jobs.delete(jobId);
        this.pendingInputs.delete(jobId);
        this.controllers.delete(jobId);
        this.finished.delete(jobId);
        this.eventWriteChains.delete(jobId);
      }
      await this.#persist();
      await Promise.all([...removedIds].map((jobId) => this.store.removeJobDirectory(jobId)));
      return removedIds.size;
    } finally {
      if (ownsRemoval) this.endWorkspaceRemoval(workspacePath);
    }
  }

  #activeOrQueuedCount() {
    return [...this.jobs.values()].filter((job) => ["queued", "running"].includes(job.status)).length;
  }

  async createJob(input) {
    const inputWorkspaceKey = workspaceKey(input.workspace);
    if (this.workspaceRemovals.has(inputWorkspaceKey)) {
      throw new HttpError(409, "workspace is being removed", "workspace_busy");
    }
    const requestFingerprint = fingerprint(input);
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.fingerprint === requestFingerprint) {
          return { job: existing, replayed: true };
        }
        throw new HttpError(409, "idempotencyKey was already used for another request", "idempotency_conflict");
      }
    }

    if (input.agentId) {
      const active = [...this.jobs.values()].find(
        (job) => job.agentId === input.agentId && ["queued", "running"].includes(job.status),
      );
      if (active) {
        throw new HttpError(409, "this conversation already has an active turn", "conversation_busy");
      }
      const previous = [...this.jobs.values()].find(
        (job) => job.agentId === input.agentId && job.workspace !== input.workspace,
      );
      if (previous) {
        throw new HttpError(409, "a conversation cannot change workspace", "conversation_workspace_conflict");
      }
    }

    if (this.#activeOrQueuedCount() >= this.config.maxConcurrentJobs + this.config.maxQueuedJobs) {
      throw new HttpError(429, "job queue is full", "queue_full");
    }

    const id = randomUUID();
    const job = {
      id,
      status: "queued",
      workspace: input.workspace,
      prompt: input.prompt,
      agentId: input.agentId ?? null,
      model: input.model ?? this.config.runner?.model ?? null,
      timeoutSeconds: input.timeoutSeconds,
      idempotencyKey: input.idempotencyKey ?? null,
      fingerprint: requestFingerprint,
      runner: this.runner.mode,
      thread: input.thread ?? null,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      metadata: {},
      finalReport: null,
      activityText: "",
      artifacts: [],
    };

    await this.store.writeInitialJob(job, {
      prompt: input.prompt,
      workspace: input.workspace,
      agentId: input.agentId ?? null,
      model: job.model,
      timeoutSeconds: input.timeoutSeconds,
      thread: input.thread ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    if (this.workspaceRemovals.has(inputWorkspaceKey)) {
      await this.store.removeJobDirectory(id);
      throw new HttpError(409, "workspace is being removed", "workspace_busy");
    }
    this.jobs.set(id, job);
    this.pendingInputs.set(id, input);
    await this.#persist();
    this.#appendEvent(job, "queued", {});
    setImmediate(() => this.#drain());
    return { job, replayed: false };
  }

  #drain() {
    while (this.activeCount < this.config.maxConcurrentJobs) {
      const next = [...this.jobs.values()]
        .filter((job) => job.status === "queued" && this.pendingInputs.has(job.id))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!next) {
        return;
      }
      const input = this.pendingInputs.get(next.id);
      this.pendingInputs.delete(next.id);
      this.activeCount += 1;
      void this.#run(next, input).finally(() => {
        this.activeCount -= 1;
        this.#drain();
      });
    }
  }

  #appendEvent(job, type, data) {
    const event = {
      seq: (job.lastEventSequence ?? 0) + 1,
      timestamp: nowIso(),
      type,
      ...data,
    };
    job.lastEventSequence = event.seq;
    this.eventEmitter.emit(job.id, event);

    const chain = (this.eventWriteChains.get(job.id) ?? Promise.resolve())
      .then(() => appendFile(this.store.eventsPath(job.id), `${JSON.stringify(event)}\n`, "utf8"))
      .catch((error) => {
        console.error(`Failed to append job event for ${job.id}: ${safeErrorMessage(error)}`);
      });
    this.eventWriteChains.set(job.id, chain);
    return event;
  }

  async #finish(job, status, error = null, result = {}) {
    if (this.finished.has(job.id)) {
      return;
    }
    this.finished.add(job.id);
    job.status = status;
    job.finishedAt = nowIso();
    job.exitCode = result.exitCode ?? null;
    job.signal = result.signal ?? null;
    job.metadata = result.metadata ?? {};
    job.agentId = job.metadata.agentId ?? job.agentId ?? null;
    if (job.metadata.model) {
      const resolvedModel = typeof job.metadata.model === "string"
        ? { id: job.metadata.model }
        : job.metadata.model;
      job.model = job.model && typeof job.model === "object"
        ? { ...job.model, ...resolvedModel }
        : resolvedModel;
    }
    if (status === "failed" && /API key exchange|fetch failed|ECONN|ETIMEDOUT|network|socket/i.test(error ?? "")) {
      error = "Cursor 网络连接失败，这次 Run 没有正常完成。请确认本机能访问 https://api2.cursor.sh，然后重新发送；如果频繁出现，请检查系统代理、VPN 和 DNS。";
    }
    job.error = error;

    const eventWriteChain = this.eventWriteChains.get(job.id);
    if (eventWriteChain) {
      await eventWriteChain;
    }

    let finalText;
    try {
      finalText = await readFile(path.join(this.store.jobDirectory(job.id), "final.md"), "utf8");
    } catch {
      finalText = undefined;
    }
    job.finalReport = finalText ?? null;
    this.#appendEvent(job, "done", {
      status,
      error,
      exitCode: job.exitCode,
      signal: job.signal,
      metadata: job.metadata,
      artifacts: job.artifacts,
      finalReport: finalText?.slice(0, 64 * 1024),
    });
    await this.#persist();
  }

  async #run(job, input) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = "running";
    job.startedAt = nowIso();
    this.#appendEvent(job, "started", { runner: this.runner.mode });
    await this.#persist();

    let eventBytes = 0;
    let outputLimitExceeded = false;
    let timer;
    const outputDir = this.store.jobDirectory(job.id);
    const completionFile = path.join(job.workspace, ".agent-runs", job.id, "final.md");
    const runInput = { ...input, recoverAgent: false };

    const observeChunk = (type) => (text) => {
      eventBytes += Buffer.byteLength(text, "utf8");
      if (eventBytes > this.config.maxOutputBytes && !outputLimitExceeded) {
        outputLimitExceeded = true;
        controller.abort(new Error("job output exceeded the configured limit"));
        return;
      }
      this.#appendEvent(job, type, { text });
      appendActivityText(job, readableActivity({ type, text }));
    };

    const observeEvent = (details) => {
      const text = JSON.stringify(details);
      eventBytes += Buffer.byteLength(text, "utf8");
      if (eventBytes > this.config.maxOutputBytes && !outputLimitExceeded) {
        outputLimitExceeded = true;
        controller.abort(new Error("job output exceeded the configured limit"));
        return;
      }
      this.#appendEvent(job, "activity", details);
      appendActivityText(job, readableActivity({ type: "activity", ...details }));
    };

    timer = setTimeout(() => {
      controller.abort(new Error("job timed out"));
    }, input.timeoutSeconds * 1000);
    timer.unref?.();

    try {
      const execute = () => this.runner.execute({
        job,
        prompt: runInput.prompt,
        workspace: job.workspace,
        outputDir,
        completionFile,
        thread: runInput.thread,
        agentId: runInput.agentId,
        recoverAgent: runInput.recoverAgent,
        model: job.model,
        onInterrupt: (handler) => {
          this.interruptHandlers.set(job.id, handler);
        },
        signal: controller.signal,
        onStdout: observeChunk("stdout"),
        onStderr: observeChunk("stderr"),
        onEvent: observeEvent,
      });
      let result;
      try {
        result = await execute();
      } catch (error) {
        const missingAgent = runInput.agentId &&
          /agent.*not found|找不到会话|no agent|invalid agent|agent.*missing/i.test(safeErrorMessage(error));
        if (!missingAgent) throw error;
        this.#appendEvent(job, "activity", {
          kind: "status",
          status: "RECOVERY",
          text: "旧会话不可恢复，已创建新的本地 Agent",
        });
        runInput.agentId = undefined;
        runInput.recoverAgent = true;
        job.agentId = null;
        result = await execute();
      }

      const git = await captureGitSnapshot(job.workspace, outputDir);
      const completionRelative = path.relative(outputDir, completionFile);
      const completionInsideJob = !(
        completionRelative.startsWith(`..${path.sep}`) ||
        completionRelative === ".." ||
        path.isAbsolute(completionRelative)
      );
      if (completionInsideJob) {
        try {
          const completionText = await readFile(completionFile, "utf8");
          await writeFileIfMissing(path.join(outputDir, "final.md"), completionText);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
      }
      const artifacts = [];
      for (const name of ["final.md", "changes.diff", "git-status.txt"]) {
        try {
          if ((await stat(path.join(outputDir, name))).isFile()) {
            artifacts.push(name);
          }
        } catch {
          // Missing artifacts are valid when the task changed no tracked files.
        }
      }
      job.artifacts = artifacts;

      let status = result.exitCode === 0 && result.signal == null ? "succeeded" : "failed";
      let error =
        status === "succeeded"
          ? null
          : result.error ?? `runner exited with code ${result.exitCode}`;
      if (controller.signal.aborted) {
        const completedBeforeAbort = result.exitCode === 0 && result.metadata?.cursorStatus === "finished";
        status = completedBeforeAbort
          ? "succeeded"
          : job.cancelReason === "timeout" || controller.signal.reason?.message === "job timed out"
          ? "timed_out"
          : "cancelled";
        error = completedBeforeAbort ? null : controller.signal.reason?.message ?? "job cancelled";
      }
      await this.#finish(job, status, error, { ...result, metadata: { ...result.metadata, git } });
    } catch (error) {
      const abortMessage = controller.signal.reason?.message ?? "";
      const status =
        job.cancelReason === "timeout" || abortMessage === "job timed out"
          ? "timed_out"
          : controller.signal.aborted
            ? "cancelled"
            : "failed";
      if (status === "failed") {
        observeChunk("stderr")(initializationDiagnostic(error));
      }
      await this.#finish(job, status, safeErrorMessage(error));
    } finally {
      clearTimeout(timer);
      this.interruptHandlers.delete(job.id);
      this.controllers.delete(job.id);
    }
  }

  async interruptJob(jobId, message) {
    const job = this.#jobOrThrow(jobId);
    if (this.finished.has(jobId) || job.status !== "running") {
      throw new HttpError(409, "job is not running", "job_not_running");
    }
    const handler = this.interruptHandlers.get(jobId);
    if (!handler) {
      throw new HttpError(409, "job has not started a Cursor run yet", "job_not_ready");
    }
    const result = await handler(message);
    if (!result?.accepted) {
      throw new HttpError(409, "Cursor did not accept the interruption", result?.reason ?? "interrupt_rejected");
    }
    this.#appendEvent(job, "interrupt", { text: message, outcome: result.outcome });
    return job;
  }

  async cancelJob(jobId) {
    const job = this.#jobOrThrow(jobId);
    if (this.finished.has(jobId)) {
      return job;
    }
    job.cancelReason = "user";
    if (job.status === "queued") {
      this.pendingInputs.delete(jobId);
      await this.#finish(job, "cancelled", "cancelled before execution", {
        metadata: { cancelReason: "user", cancelPhase: "queued" },
      });
      return job;
    }
    const controller = this.controllers.get(jobId);
    if (controller) {
      controller.abort(new Error("job cancelled"));
    }
    return job;
  }

  subscribe(jobId, listener) {
    this.#jobOrThrow(jobId);
    this.eventEmitter.on(jobId, listener);
    return () => this.eventEmitter.off(jobId, listener);
  }

  async eventsAfter(jobId, afterSequence = 0) {
    this.#jobOrThrow(jobId);
    const writeChain = this.eventWriteChains.get(jobId);
    if (writeChain) {
      await writeChain;
    }
    let content = "";
    try {
      content = await readFile(this.store.eventsPath(jobId), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter((event) => event && event.seq > afterSequence);
  }

  async readArtifact(jobId, name) {
    this.#jobOrThrow(jobId);
    if (!["final.md", "changes.diff", "git-status.txt"].includes(name)) {
      throw new HttpError(404, "artifact not found", "artifact_not_found");
    }
    try {
      return await readFile(path.join(this.store.jobDirectory(jobId), name));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new HttpError(404, "artifact not found", "artifact_not_found");
      }
      throw error;
    }
  }
}
