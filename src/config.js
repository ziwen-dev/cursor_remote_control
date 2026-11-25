import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(moduleDirectory, "..");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveFromProject(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectRoot, value);
}

function integerFrom(value, fallback, name, minimum, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export async function ensureApiToken(config) {
  const environmentToken = process.env.BRIDGE_API_TOKEN;
  if (environmentToken) {
    if (environmentToken.length < 32) {
      throw new Error("BRIDGE_API_TOKEN must contain at least 32 characters");
    }
    return environmentToken;
  }

  if (await exists(config.tokenFile)) {
    const token = (await readFile(config.tokenFile, "utf8")).trim();
    if (token.length >= 32) {
      return token;
    }
    throw new Error("The configured token file does not contain a valid token");
  }

  const token = randomBytes(32).toString("hex");
  await mkdir(path.dirname(config.tokenFile), { recursive: true });
  await writeFile(config.tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

export async function loadConfig(options = {}) {
  const configPath = path.resolve(
    options.configPath ?? process.env.BRIDGE_CONFIG ?? path.join(projectRoot, "config", "bridge.config.json"),
  );
  const raw = JSON.parse(await readFile(configPath, "utf8"));

  const host = options.host ?? process.env.BRIDGE_HOST ?? raw.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("The bridge must bind to a loopback host. Use frpc for external access.");
  }

  const config = {
    configPath,
    host,
    port: integerFrom(
      options.port ?? process.env.BRIDGE_PORT,
      raw.port,
      "port",
      options.allowEphemeralPort ? 0 : 1,
      65535,
    ),
    publicDir: resolveFromProject(raw.publicDir ?? "public"),
    dataDir: resolveFromProject(raw.dataDir ?? "data"),
    tokenFile: resolveFromProject(raw.tokenFile ?? "data/api-token.txt"),
    allowedWorkspaces: (options.allowedWorkspaces ?? raw.allowedWorkspaces ?? []).map(resolveFromProject),
    maxConcurrentJobs: integerFrom(
      raw.maxConcurrentJobs,
      2,
      "maxConcurrentJobs",
      1,
      32,
    ),
    maxQueuedJobs: integerFrom(raw.maxQueuedJobs, 20, "maxQueuedJobs", 1, 1000),
    maxOutputBytes: integerFrom(raw.maxOutputBytes, 8 * 1024 * 1024, "maxOutputBytes", 64 * 1024, 256 * 1024 * 1024),
    defaultTimeoutSeconds: integerFrom(
      raw.defaultTimeoutSeconds,
      1800,
      "defaultTimeoutSeconds",
      5,
      24 * 60 * 60,
    ),
    runner: options.runner ?? raw.runner ?? { mode: "command", command: "node", args: [] },
  };

  if (config.allowedWorkspaces.length === 0) {
    throw new Error("At least one allowed workspace must be configured");
  }
  config.apiToken = options.apiToken ?? (await ensureApiToken(config));
  return config;
}
