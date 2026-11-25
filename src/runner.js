import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCursorSdkRunner } from "./cursor-sdk-runner.js";

function childEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra };
  delete environment.BRIDGE_API_TOKEN;
  delete environment.BRIDGE_CONFIG;
  return environment;
}

async function terminateProcessTree(pid) {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      execFile("taskkill.exe", ["/pid", String(pid), "/t", "/f"], () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process may already have exited.
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

function expandArguments(args, values) {
  return args.map((argument) =>
    argument.replace(/\{(prompt|jobId|workspace|outputDir|completionFile)\}/g, (_, key) => values[key] ?? ""),
  );
}

function quoteForCmd(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function spawnExecutable(command, args, options) {
  const isBatch = /\.(cmd|bat)$/i.test(command);
  if (process.platform === "win32" && isBatch) {
    const commandLine = [command, ...args].map(quoteForCmd).join(" ");
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", commandLine], {
      ...options,
      windowsHide: true,
    });
  }
  return spawn(command, args, {
    ...options,
    windowsHide: true,
  });
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function runCaptured(command, args, options = {}) {
  const child = spawnExecutable(command, args, {
    cwd: options.cwd,
    env: childEnvironment(options.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const maximum = options.maximumBytes ?? 4 * 1024 * 1024;

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    if (Buffer.byteLength(stdout) > maximum) {
      void terminateProcessTree(child.pid);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (Buffer.byteLength(stderr) > maximum) {
      void terminateProcessTree(child.pid);
    }
  });
  child.stdin.end(options.stdin ?? "");
  const result = await waitForChild(child);
  return { ...result, stdout, stderr };
}

async function runCommandRunner(config, context) {
  const promptPath = path.join(context.outputDir, "prompt.txt");
  const completionFile = context.completionFile;
  await writeFile(promptPath, context.prompt, "utf8");

  const values = {
    prompt: context.prompt,
    jobId: context.job.id,
    workspace: context.workspace,
    outputDir: context.outputDir,
    completionFile,
  };
  const args = expandArguments(config.args ?? [], values);
  const isBatch = /\.(cmd|bat)$/i.test(config.command);
  if (isBatch && args.some((argument) => argument.includes(context.prompt))) {
    throw new Error("Command runner .cmd/.bat arguments cannot contain prompt text. Read BRIDGE_PROMPT_FILE instead.");
  }

  const child = spawnExecutable(config.command, args, {
    cwd: context.workspace,
    env: childEnvironment({
      ...config.env,
      BRIDGE_JOB_ID: context.job.id,
      BRIDGE_WORKSPACE: context.workspace,
      BRIDGE_PROMPT_FILE: promptPath,
      BRIDGE_OUTPUT_DIR: context.outputDir,
      BRIDGE_COMPLETION_FILE: completionFile,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const abortHandler = () => {
    void terminateProcessTree(child.pid);
  };
  context.signal.addEventListener("abort", abortHandler, { once: true });
  child.stdout.on("data", (chunk) => context.onStdout(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => context.onStderr(chunk.toString("utf8")));

  try {
    const result = await waitForChild(child);
    return {
      exitCode: result.code ?? 1,
      signal: result.signal,
      metadata: {},
    };
  } finally {
    context.signal.removeEventListener("abort", abortHandler);
  }
}

async function readJsonOutput(result, action) {
  const text = result.stdout.trim();
  if (result.stderr.trim()) {
    const warning = result.stderr.trim();
    if (warning.includes("is not in the list of known options")) {
      throw new Error(
        "Cursor Desktop Bridge is unavailable. Enable the Cursor beta feature and restart Cursor before using cursor-desktop mode.",
      );
    }
  }
  if (!text) {
    throw new Error(`Cursor desktop returned no JSON for ${action}. Is Desktop Bridge enabled?`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Cursor desktop returned invalid JSON for ${action}: ${text.slice(0, 500)}`);
  }
}

async function listDesktopThreads(config, context) {
  const result = await runCaptured(config.cursorCommand, ["desktop", "ls", "--json"], {
    cwd: context.workspace,
    env: config.env,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Cursor desktop ls exited with code ${result.code}`);
  }
  const parsed = await readJsonOutput(result, "desktop ls");
  if (!Array.isArray(parsed)) {
    throw new Error("Cursor desktop ls returned an invalid thread list");
  }
  return parsed;
}

async function sendDesktopMessage(config, context, threadId, text) {
  const result = await runCaptured(
    config.cursorCommand,
    ["desktop", "send", threadId, "--stdin", "--json"],
    {
      cwd: context.workspace,
      env: config.env,
      stdin: text,
    },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Cursor desktop send exited with code ${result.code}`);
  }
  return readJsonOutput(result, "desktop send");
}

function completionPath(config, context) {
  const configured = (config.completionFile ?? ".agent-runs/{jobId}/final.md").replace(
    /\{jobId\}/g,
    context.job.id,
  );
  const absolute = path.resolve(context.workspace, configured);
  const relative = path.relative(context.workspace, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Cursor completionFile must stay inside the selected workspace");
  }
  return absolute;
}

async function runCursorDesktopRunner(config, context) {
  const threadId = context.thread ?? config.defaultThread;
  if (!threadId) {
    throw new Error("cursor-desktop mode requires thread in the job or runner.defaultThread in configuration");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error("Cursor thread must be a UUID");
  }

  const finalPath = completionPath(config, context);
  await mkdir(path.dirname(finalPath), { recursive: true });
  const deliveryInstruction = [
    "",
    "",
    "---",
    "Cursor Remote Bridge output requirement:",
    `When the task is complete, write your final response to ${finalPath}.`,
    "Include a concise summary, tests run, remaining risks, and files changed.",
  ].join("\n");
  const message = `${context.prompt.trim()}\n${deliveryInstruction}`;
  const sent = await sendDesktopMessage(config, context, threadId, message);
  context.onStdout(`Cursor desktop accepted the message: ${JSON.stringify(sent)}\n`);

  let sawRunning = false;
  let latestStatus = "unknown";
  const pollInterval = Math.max(500, Number(config.pollIntervalMs ?? 2000));
  while (!context.signal.aborted) {
    const threads = await listDesktopThreads(config, context);
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      throw new Error(`Cursor thread ${threadId} disappeared while the job was running`);
    }
    latestStatus = thread.status ?? "unknown";
    context.onStdout(`Cursor thread status: ${latestStatus}\n`);
    if (latestStatus === "running") {
      sawRunning = true;
    }

    let finalText;
    try {
      finalText = await readFile(finalPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (finalText !== undefined) {
      await writeFile(path.join(context.outputDir, "final.md"), finalText, "utf8");
      return {
        exitCode: 0,
        signal: null,
        metadata: {
          threadId,
          threadTitle: thread.title,
          cursorStatus: latestStatus,
          completionFile: finalPath,
        },
      };
    }
    if ((latestStatus === "completed" || latestStatus === "error") && sawRunning) {
      context.onStderr("Cursor completed without writing the required final report file.\n");
      return {
        exitCode: latestStatus === "error" ? 1 : 2,
        signal: null,
        metadata: { threadId, threadTitle: thread.title, cursorStatus: latestStatus },
      };
    }
    await delay(pollInterval, context.signal);
  }

  throw context.signal.reason ?? new Error("Cursor desktop job cancelled");
}

async function runGit(command, args, workspace) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => resolve({ error, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
  });
}

const MAX_GIT_DIFF_BYTES = 16 * 1024 * 1024;

function appendDiff(current, addition) {
  if (!addition) return current;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  const combined = `${current}${separator}${addition}`;
  if (Buffer.byteLength(combined, "utf8") <= MAX_GIT_DIFF_BYTES) return combined;
  const marker = "\n# Cursor Bridge diff truncated at 16 MiB\n";
  return `${combined.slice(0, Math.max(0, MAX_GIT_DIFF_BYTES - Buffer.byteLength(marker, "utf8")))}${marker}`;
}

export async function captureGitSnapshot(workspace, outputDir) {
  const inside = await runGit("git", ["rev-parse", "--is-inside-work-tree"], workspace);
  if (inside.error || inside.stdout.trim() !== "true") {
    return { isGit: false };
  }

  const status = await runGit(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    workspace,
  );
  const diff = await runGit("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], workspace);
  const untracked = await runGit(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    workspace,
  );
  const result = { isGit: true, statusFile: undefined, diffFile: undefined };

  if (!status.error && status.stdout) {
    result.statusFile = "git-status.txt";
    await writeFile(path.join(outputDir, result.statusFile), status.stdout, "utf8");
  }
  let changeDiff = !diff.error ? diff.stdout : "";
  if (!untracked.error) {
    for (const file of untracked.stdout.split("\0").filter(Boolean)) {
      const fileDiff = await runGit(
        "git",
        ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", file],
        workspace,
      );
      if (fileDiff.stdout) changeDiff = appendDiff(changeDiff, fileDiff.stdout);
      if (Buffer.byteLength(changeDiff, "utf8") >= MAX_GIT_DIFF_BYTES) break;
    }
  }
  if (changeDiff) {
    result.diffFile = "changes.diff";
    await writeFile(path.join(outputDir, result.diffFile), changeDiff, "utf8");
  }
  return result;
}

export function createRunner(config) {
  if (config.mode === "command") {
    if (typeof config.command !== "string" || config.command.trim() === "") {
      throw new Error("command runner requires runner.command");
    }
    return {
      mode: "command",
      execute: (context) => runCommandRunner(config, context),
    };
  }
  if (config.mode === "cursor-desktop") {
    if (typeof config.cursorCommand !== "string" || config.cursorCommand.trim() === "") {
      throw new Error("cursor-desktop runner requires runner.cursorCommand");
    }
    return {
      mode: "cursor-desktop",
      execute: (context) => runCursorDesktopRunner(config, context),
    };
  }
  if (config.mode === "cursor-sdk") {
    return {
      mode: "cursor-sdk",
      execute: (context) => runCursorSdkRunner(config, context),
    };
  }
  throw new Error(`Unsupported runner mode: ${config.mode}`);
}
