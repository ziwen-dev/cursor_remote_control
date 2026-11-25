import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";

const MAX_DIRECTORY_ENTRIES = 5000;
const MAX_PREVIEW_BYTES = 1536 * 1024;
const BINARY_PROBE_BYTES = 8192;
const IGNORED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", ".agent-runs"]);
const EXECUTABLE_EXTENSIONS = new Set([
  ".a", ".apk", ".app", ".bin", ".class", ".com", ".dll", ".dylib", ".exe",
  ".jar", ".lib", ".msi", ".node", ".o", ".obj", ".pdb", ".pyc", ".pyo",
  ".so", ".sys", ".wasm",
]);
const PRIVATE_KEY_EXTENSIONS = new Set([".key", ".p12", ".pem", ".pfx"]);
const SENSITIVE_FILE_NAMES = new Set([
  "api-token.txt",
  "auth.json",
  "cursor-api-key.txt",
  "credentials",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

const LANGUAGE_BY_EXTENSION = new Map([
  [".bat", "batch"], [".c", "c"], [".cc", "cpp"], [".cmd", "batch"],
  [".cpp", "cpp"], [".cs", "csharp"], [".css", "css"], [".diff", "diff"],
  [".dockerfile", "dockerfile"], [".go", "go"], [".graphql", "graphql"],
  [".h", "c"], [".hpp", "cpp"], [".html", "html"], [".ini", "ini"],
  [".java", "java"], [".js", "javascript"], [".json", "json"], [".jsx", "javascript"],
  [".kt", "kotlin"], [".less", "less"], [".log", "text"], [".md", "markdown"],
  [".mjs", "javascript"], [".php", "php"], [".properties", "properties"],
  [".ps1", "powershell"], [".py", "python"], [".rb", "ruby"], [".rs", "rust"],
  [".scss", "scss"], [".sh", "shell"], [".sql", "sql"], [".svelte", "svelte"],
  [".svg", "xml"], [".toml", "toml"], [".ts", "typescript"], [".tsx", "typescript"],
  [".txt", "text"], [".vue", "vue"], [".xml", "xml"], [".yaml", "yaml"],
  [".yml", "yaml"],
]);

function normalizeRelative(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function comparePathNames(left, right) {
  return left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" });
}

function languageFor(fileName) {
  const lower = fileName.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  return LANGUAGE_BY_EXTENSION.get(path.extname(lower)) ?? "text";
}

function isSensitiveFile(relativePath) {
  const normalized = normalizeRelative(relativePath);
  const name = path.posix.basename(normalized).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (SENSITIVE_FILE_NAMES.has(name)) return true;
  return PRIVATE_KEY_EXTENSIONS.has(path.posix.extname(name));
}

function fileNameFlag(fileName) {
  const lower = fileName.toLowerCase();
  if (EXECUTABLE_EXTENSIONS.has(path.extname(lower))) return "executable";
  if (isSensitiveFile(lower)) return "sensitive";
  return null;
}

async function resolveWorkspaceTarget(workspace, relativePath) {
  const root = await realpath(path.resolve(workspace));
  const relative = normalizeRelative(relativePath);
  if (relative.includes("\0")) {
    throw new HttpError(400, "invalid file path", "invalid_file_path");
  }
  if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) {
    throw new HttpError(400, "file path must be relative to the workspace", "invalid_file_path");
  }
  const lexical = path.resolve(root, relative);
  if (!isInsideRoot(root, lexical)) {
    throw new HttpError(403, "file path is outside the workspace", "file_forbidden");
  }
  let target;
  try {
    target = await lstat(lexical);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new HttpError(404, "file or directory not found", "file_not_found");
    }
    throw error;
  }
  if (target.isSymbolicLink()) {
    throw new HttpError(403, "symbolic links cannot be opened", "symlink_forbidden");
  }
  const actual = await realpath(lexical);
  if (!isInsideRoot(root, actual)) {
    throw new HttpError(403, "resolved path is outside the workspace", "file_forbidden");
  }
  return { root, actual, target, relative };
}

function looksBinary(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, BINARY_PROBE_BYTES));
  if (probe.length === 0) return false;
  if (probe.length >= 2 && (
    (probe[0] === 0xff && probe[1] === 0xfe) ||
    (probe[0] === 0xfe && probe[1] === 0xff)
  )) return false;
  let controls = 0;
  for (const byte of probe) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / probe.length > 0.08;
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { content: new TextDecoder("utf-16le").decode(buffer.subarray(2)), encoding: "utf-16le" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return { content: new TextDecoder("utf-16le").decode(swapped), encoding: "utf-16be" };
  }
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  if (replacementCount === 0 || replacementCount / Math.max(1, utf8.length) < 0.005) {
    return { content: utf8, encoding: "utf-8" };
  }
  try {
    return { content: new TextDecoder("gb18030", { fatal: true }).decode(buffer), encoding: "gb18030" };
  } catch {
    const error = new Error("file is not valid UTF-8, GB18030 or UTF-16 text");
    error.code = "unsupported_text_encoding";
    throw error;
  }
}

export async function listWorkspaceFiles(workspace, relativePath = "") {
  const resolved = await resolveWorkspaceTarget(workspace, relativePath);
  if (!resolved.target.isDirectory()) {
    throw new HttpError(400, "path is not a directory", "not_a_directory");
  }

  let dirents;
  try {
    dirents = await readdir(resolved.actual, { withFileTypes: true });
  } catch {
    throw new HttpError(403, "directory cannot be read", "directory_forbidden");
  }
  dirents.sort((left, right) => {
    const leftDirectory = left.isDirectory() ? 0 : 1;
    const rightDirectory = right.isDirectory() ? 0 : 1;
    return leftDirectory - rightDirectory || comparePathNames(left.name, right.name);
  });

  const entries = [];
  for (const dirent of dirents) {
    if (dirent.isDirectory() && IGNORED_DIRECTORIES.has(dirent.name)) continue;
    const relative = normalizeRelative(path.posix.join(resolved.relative, dirent.name));
    if (dirent.isSymbolicLink()) {
      entries.push({
        name: dirent.name,
        path: relative,
        type: "symlink",
        previewable: false,
        reason: "symlink",
      });
      continue;
    }
    let details;
    try {
      details = await lstat(path.join(resolved.actual, dirent.name));
    } catch {
      continue;
    }
    if (details.isDirectory()) {
      entries.push({ name: dirent.name, path: relative, type: "directory" });
      continue;
    }
    if (!details.isFile()) continue;
    const blockedReason = fileNameFlag(dirent.name);
    entries.push({
      name: dirent.name,
      path: relative,
      type: "file",
      size: details.size,
      modifiedAt: details.mtime.toISOString(),
      language: languageFor(dirent.name),
      previewable: !blockedReason,
      ...(blockedReason ? { reason: blockedReason } : {}),
    });
    if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
  }

  return {
    workspace: resolved.root,
    path: resolved.relative,
    entries,
    truncated: dirents.length > entries.length && entries.length >= MAX_DIRECTORY_ENTRIES,
  };
}

export async function readWorkspaceFile(workspace, relativePath) {
  const resolved = await resolveWorkspaceTarget(workspace, relativePath);
  if (!resolved.target.isFile()) {
    throw new HttpError(400, "path is not a file", "not_a_file");
  }
  const blockedReason = fileNameFlag(path.basename(resolved.actual));
  if (blockedReason === "sensitive") {
    throw new HttpError(403, "sensitive files cannot be previewed", "sensitive_file");
  }
  if (blockedReason === "executable") {
    throw new HttpError(415, "executable files cannot be previewed", "binary_file");
  }

  const handle = await open(resolved.actual, "r");
  let bytesRead;
  const buffer = Buffer.alloc(Math.min(resolved.target.size, MAX_PREVIEW_BYTES) + 1);
  try {
    ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
  } finally {
    await handle.close();
  }
  const truncated = bytesRead > MAX_PREVIEW_BYTES || resolved.target.size > MAX_PREVIEW_BYTES;
  const contentBuffer = buffer.subarray(0, Math.min(bytesRead, MAX_PREVIEW_BYTES));
  if (looksBinary(contentBuffer)) {
    throw new HttpError(415, "binary files cannot be previewed", "binary_file");
  }
  let decoded;
  try {
    decoded = decodeText(contentBuffer);
  } catch {
    throw new HttpError(415, "unsupported text encoding", "unsupported_text_encoding");
  }

  return {
    workspace: resolved.root,
    path: resolved.relative,
    name: path.basename(resolved.actual),
    language: languageFor(resolved.actual),
    encoding: decoded.encoding,
    content: decoded.content,
    size: resolved.target.size,
    modifiedAt: resolved.target.mtime.toISOString(),
    truncated,
    maxPreviewBytes: MAX_PREVIEW_BYTES,
  };
}

