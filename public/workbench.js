const workspace = document.querySelector("#workspace");
const workspaceList = document.querySelector("#workspace-list");
const workspaceDialog = document.querySelector("#workspace-dialog");
const workspaceForm = document.querySelector("#workspace-form");
const workspacePath = document.querySelector("#workspace-path");
const browseWorkspace = document.querySelector("#browse-workspace");
const folderPicker = document.querySelector("#folder-picker");
const folderUp = document.querySelector("#folder-up");
const folderLocation = document.querySelector("#folder-location");
const folderList = document.querySelector("#folder-list");
const folderUseCurrent = document.querySelector("#folder-use-current");
const folderClose = document.querySelector("#folder-close");
const addWorkspaceSubmit = document.querySelector("#add-workspace-submit");
const removeWorkspaceDialog = document.querySelector("#remove-workspace-dialog");
const removeWorkspaceForm = document.querySelector("#remove-workspace-form");
const removeWorkspacePath = document.querySelector("#remove-workspace-path");
const confirmRemoveWorkspace = document.querySelector("#confirm-remove-workspace");
const remoteAuthDialog = document.querySelector("#remote-auth-dialog");
const remoteAuthForm = document.querySelector("#remote-auth-form");
const remoteAuthToken = document.querySelector("#remote-auth-token");
const remoteAuthError = document.querySelector("#remote-auth-error");
const remoteAuthSubmit = document.querySelector("#remote-auth-submit");
const conversationsList = document.querySelector("#conversation-list");
const conversationCount = document.querySelector("#conversation-count");
const newConversation = document.querySelector("#new-conversation");
const addWorkspace = document.querySelector("#add-workspace");
const currentTitle = document.querySelector("#current-title");
const currentWorkspace = document.querySelector("#current-workspace");
const status = document.querySelector("#status");
const transcript = document.querySelector("#transcript");
const welcome = document.querySelector("#welcome");
const turnsElement = document.querySelector("#turns");
const prompt = document.querySelector("#prompt");
const send = document.querySelector("#send");
const cancel = document.querySelector("#cancel");
const interruptToggle = document.querySelector("#interrupt-toggle");
const interruptPanel = document.querySelector("#interrupt-panel");
const interruptMessage = document.querySelector("#interrupt-message");
const interruptSubmit = document.querySelector("#interrupt-submit");
const interruptClose = document.querySelector("#interrupt-close");
const errorElement = document.querySelector("#error");
const modelSelect = document.querySelector("#model-select");
const modelParameters = document.querySelector("#model-parameters");
const mobileMenu = document.querySelector("#mobile-menu");
const sidebarBackdrop = document.querySelector("#sidebar-backdrop");
const themeToggle = document.querySelector("#theme-toggle");
const themeIcon = document.querySelector("#theme-icon");
const themeLabel = document.querySelector("#theme-label");
const reviewDialog = document.querySelector("#review-dialog");
const reviewSummary = document.querySelector("#review-summary");
const reviewFiles = document.querySelector("#review-files");
const reviewNote = document.querySelector("#review-note");
const reviewDiffTitle = document.querySelector("#review-diff-title");
const reviewDiff = document.querySelector("#review-diff");
const reviewClose = document.querySelector("#review-close");
const mainArea = document.querySelector("#main-area");
const explorer = document.querySelector("#explorer");
const explorerToggle = document.querySelector("#explorer-toggle");
const explorerClose = document.querySelector("#explorer-close");
const explorerBackdrop = document.querySelector("#explorer-backdrop");
const explorerWorkspace = document.querySelector("#explorer-workspace");
const fileTree = document.querySelector("#file-tree");
const filePreviewTitle = document.querySelector("#file-preview-title");
const filePreviewMeta = document.querySelector("#file-preview-meta");
const fileView = document.querySelector("#file-view");
const filePreviewMode = document.querySelector("#file-preview-mode");
const STORAGE_WORKSPACES = "bridge-workspaces";
const STORAGE_THEME = "bridge-theme";
const STORAGE_MODEL = "bridge-model";
const STORAGE_GROUP_PREFIX = "bridge-group:";
const TRANSCRIPT_FOLLOW_THRESHOLD = 96;
const STATUS_LABELS = {
  idle: "就绪",
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  timed_out: "超时",
};

let authToken = "";
let meta;
let conversations = [];
let activeConversationId;
let currentJobId;
let monitorController;
let currentTurn = null;
let browseState = { path: "", parent: null, entries: [] };
let pendingWorkspaceRemoval;
let availableModels = [];
let selectedModel = "";
let selectedModelParams = [];
let preferredModelSelection = null;
let modelsLoading = false;
let modelCatalogError = "";
const activityByJob = new Map();
const disclosureState = new Map();
let activityFrame = 0;
const groupOpenState = new Map();
const expandedFileDirectories = new Set([""]);
const fileDirectoryCache = new Map();
const fileDirectoryErrors = new Map();
const loadingFileDirectories = new Set();
let activeFileDirectory;
let activeFilePath;
let changedFilePaths = new Set();
let fileExplorerLoading = false;
let activeFilePreview = null;
let markdownSourceMode = false;


function showError(message) {
  errorElement.textContent = message || "";
  errorElement.classList.toggle("visible", Boolean(message));
}

function showRemoteAuthError(message) {
  remoteAuthError.textContent = message || "";
  remoteAuthError.classList.toggle("visible", Boolean(message));
}

function showRemoteAuth() {
  setStatus("idle", "等待连接");
  showRemoteAuthError("");
  if (!remoteAuthDialog.open) remoteAuthDialog.showModal();
  requestAnimationFrame(() => remoteAuthToken.focus());
}

function headers() {
  return { authorization: `Bearer ${authToken}`, "content-type": "application/json" };
}

function setStatus(value, label = value || "就绪") {
  status.dataset.state = value || "idle";
  status.textContent = label;
}

function statusLabel(value) {
  return STATUS_LABELS[value] ?? value ?? "就绪";
}

function randomUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto.getRandomValues !== "function") {
    throw new Error("当前浏览器无法生成任务 ID，请使用现代浏览器或 HTTPS。 ");
  }
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeModelSelection(value) {
  const selection = typeof value === "string" ? { id: value } : value;
  if (!selection || typeof selection.id !== "string" || !selection.id.trim()) return null;
  const params = Array.isArray(selection.params)
    ? selection.params.filter((param) =>
        typeof param?.id === "string" && typeof param?.value === "string"
      )
    : [];
  return {
    id: selection.id.trim(),
    ...(params.length ? { params } : {}),
    ...(typeof selection.maxMode === "boolean" ? { maxMode: selection.maxMode } : {}),
  };
}

function modelId(value) {
  return normalizeModelSelection(value)?.id ?? "";
}

function configuredModelSelection() {
  return normalizeModelSelection(meta?.model);
}

function availableModel(id) {
  return availableModels.find((model) => modelId(model) === id);
}

function parameterLabel(definition) {
  return definition?.displayName || definition?.id || "参数";
}

function parameterValueLabel(definition, value) {
  const entry = definition?.values?.find((candidate) => candidate.value === value);
  return entry?.displayName || value;
}

function sameParams(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((param) => right.some((other) => other.id === param.id && other.value === param.value));
}

function defaultModelParams(model) {
  const variant = model?.variants?.find((candidate) => candidate.isDefault)
    ?? model?.variants?.[0];
  if (variant?.params) return variant.params.map((param) => ({ id: param.id, value: param.value }));
  return (model?.parameters ?? [])
    .filter((definition) => definition.values?.[0]?.value !== undefined)
    .map((definition) => ({ id: definition.id, value: definition.values[0].value }));
}

function reconcileModelSelection(value, priorityParameterIds = []) {
  const selection = normalizeModelSelection(value);
  if (!selection) return null;
  const model = availableModel(selection.id);
  if (!model) return selection;
  const requested = selection.params ?? [];
  if (Array.isArray(model.variants) && model.variants.length > 0) {
    const compatible = model.variants.filter((variant) =>
      requested.every((param) =>
        variant.params?.some((candidate) => candidate.id === param.id && candidate.value === param.value)
      )
    );
    const ranked = [...model.variants].sort((left, right) => {
      const priorityMatches = (variant) => priorityParameterIds.filter((id) =>
        requested.some((param) => param.id === id && variant.params?.some((candidate) =>
          candidate.id === id && candidate.value === param.value
        ))
      ).length;
      const totalMatches = (variant) => requested.filter((param) =>
        variant.params?.some((candidate) => candidate.id === param.id && candidate.value === param.value)
      ).length;
      return priorityMatches(right) - priorityMatches(left)
        || totalMatches(right) - totalMatches(left)
        || Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault));
    });
    const variant = compatible.find((candidate) => sameParams(candidate.params, requested))
      ?? compatible.find((candidate) => candidate.isDefault)
      ?? compatible[0]
      ?? ranked[0];
    return {
      id: selection.id,
      ...(variant?.params?.length ? { params: variant.params.map((param) => ({ ...param })) } : {}),
      ...(selection.maxMode === undefined ? {} : { maxMode: selection.maxMode }),
    };
  }
  const defaults = defaultModelParams(model);
  const params = (model.parameters ?? []).flatMap((definition) => {
    const selected = requested.find((param) =>
      param.id === definition.id && definition.values?.some((entry) => entry.value === param.value)
    );
    const fallback = defaults.find((param) => param.id === definition.id);
    return selected || fallback ? [selected || fallback] : [];
  });
  return {
    id: selection.id,
    ...(params.length ? { params } : {}),
    ...(selection.maxMode === undefined ? {} : { maxMode: selection.maxMode }),
  };
}

function currentModelSelection() {
  if (!selectedModel) return null;
  return reconcileModelSelection({ id: selectedModel, params: selectedModelParams });
}

function modelDescription(value) {
  const selection = normalizeModelSelection(value);
  if (!selection) return "";
  const model = availableModel(selection.id);
  const parts = [model?.displayName ?? selection.id, `ID: ${selection.id}`];
  for (const param of selection.params ?? []) {
    const definition = model?.parameters?.find((candidate) => candidate.id === param.id);
    parts.push(`${parameterLabel(definition)}: ${parameterValueLabel(definition, param.value)}`);
  }
  if (model?.description) parts.push(model.description);
  return parts.filter(Boolean).join("\n");
}

function compactModelDescription(value) {
  const selection = normalizeModelSelection(value);
  if (!selection) return "";
  const model = availableModel(selection.id);
  const params = (selection.params ?? []).map((param) => {
    const definition = model?.parameters?.find((candidate) => candidate.id === param.id);
    return `${parameterLabel(definition)}=${parameterValueLabel(definition, param.value)}`;
  });
  return [selection.id, ...params].join(" · ");
}

function readPreferredModelSelection() {
  try {
    const raw = localStorage.getItem(STORAGE_MODEL);
    if (!raw) return null;
    try { return normalizeModelSelection(JSON.parse(raw)); }
    catch { return normalizeModelSelection(raw); }
  } catch {
    return null;
  }
}

function persistPreferredModelSelection(selection) {
  preferredModelSelection = selection;
  try { localStorage.setItem(STORAGE_MODEL, JSON.stringify(selection)); } catch { /* Current selection still applies. */ }
}

function refreshModelTitle() {
  const selection = currentModelSelection();
  modelSelect.title = selection
    ? `${modelDescription(selection)}${modelCatalogError ? `\n${modelCatalogError}` : ""}`
    : "没有可用模型";
}

function fastValues(definition) {
  if (definition?.values?.length !== 2) return null;
  if (!/fast|speed|turbo/i.test(`${definition.id ?? ""} ${definition.displayName ?? ""}`)) return null;
  const truthy = definition.values.find((entry) =>
    /^(true|1|on|enabled|yes|fast|turbo)$/i.test(entry.value)
    || /fast|turbo|enabled|开启/i.test(entry.displayName ?? "")
  );
  const falsy = definition.values.find((entry) => entry !== truthy);
  return truthy && falsy ? { truthy: truthy.value, falsy: falsy.value } : null;
}

function updateModelParameter(parameterId, value) {
  const params = selectedModelParams.filter((param) => param.id !== parameterId);
  params.push({ id: parameterId, value });
  const selection = reconcileModelSelection({ id: selectedModel, params }, [parameterId]);
  selectedModelParams = selection?.params ?? [];
  persistPreferredModelSelection(currentModelSelection());
  renderModelParameters();
  refreshModelTitle();
}

function renderVariantFallback(model) {
  if (!Array.isArray(model?.variants) || model.variants.length < 2) return;
  const select = document.createElement("select");
  select.className = "parameter-select";
  select.setAttribute("aria-label", `${model.displayName || model.id} 变体`);
  const selectedIndex = Math.max(0, model.variants.findIndex((variant) => sameParams(variant.params, selectedModelParams)));
  model.variants.forEach((variant, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = variant.displayName || `组合 ${index + 1}`;
    option.title = variant.description || "";
    select.append(option);
  });
  select.value = String(selectedIndex);
  select.addEventListener("change", () => {
    const variant = model.variants[Number(select.value)];
    if (!variant) return;
    selectedModelParams = variant.params?.map((param) => ({ ...param })) ?? [];
    persistPreferredModelSelection(currentModelSelection());
    renderModelOptions(currentModelSelection());
  });
  modelParameters.append(select);
}

function renderModelParameters() {
  modelParameters.replaceChildren();
  const model = availableModel(selectedModel);
  if (modelsLoading || !model) return;
  const definitions = Array.isArray(model.parameters) ? model.parameters : [];
  if (definitions.length === 0) {
    renderVariantFallback(model);
    return;
  }
  for (const definition of definitions) {
    const selected = selectedModelParams.find((param) => param.id === definition.id)?.value
      ?? definition.values?.[0]?.value;
    if (selected === undefined) continue;
    const wrapper = document.createElement("span");
    wrapper.className = "model-parameter";
    const fast = fastValues(definition);
    if (fast) {
      const label = document.createElement("label");
      label.className = "fast-toggle";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected === fast.truthy;
      input.setAttribute("aria-label", parameterLabel(definition));
      input.addEventListener("change", () => updateModelParameter(
        definition.id,
        input.checked ? fast.truthy : fast.falsy,
      ));
      const text = document.createElement("span");
      text.textContent = parameterLabel(definition);
      label.append(input, text);
      wrapper.append(label);
    } else {
      const label = document.createElement("label");
      label.className = "parameter-label";
      label.textContent = parameterLabel(definition);
      const select = document.createElement("select");
      select.className = "parameter-select";
      select.setAttribute("aria-label", parameterLabel(definition));
      for (const entry of definition.values ?? []) {
        const option = document.createElement("option");
        option.value = entry.value;
        option.textContent = entry.displayName || entry.value;
        select.append(option);
      }
      select.value = selected;
      select.addEventListener("change", () => updateModelParameter(definition.id, select.value));
      wrapper.append(label, select);
    }
    modelParameters.append(wrapper);
  }
}

function renderModelOptions(preferred = preferredModelSelection) {
  const unique = new Map();
  for (const model of availableModels) {
    const id = modelId(model);
    if (id) unique.set(id, { ...model, id });
  }
  const configured = configuredModelSelection();
  if (unique.size === 0 && configured) {
    unique.set(configured.id, { id: configured.id, displayName: configured.id });
  }
  const models = [...unique.values()];
  const requested = normalizeModelSelection(preferred);
  const requestedAvailable = requested && models.some((model) => model.id === requested.id);
  const candidate = models.find((model) => model.id === requested?.id)
    ?? models.find((model) => model.id === configured?.id)
    ?? models[0];
  const reconciled = reconcileModelSelection(
    requestedAvailable && requested?.id === candidate?.id ? requested : { id: candidate?.id },
  );
  modelSelect.replaceChildren(...models.map((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.displayName && model.displayName !== model.id
      ? `${model.displayName} · ${model.id}`
      : model.id;
    option.title = model.description || model.displayName || model.id;
    return option;
  }));
  selectedModel = reconciled?.id ?? "";
  selectedModelParams = reconciled?.params ?? [];
  modelSelect.value = selectedModel;
  modelSelect.disabled = modelsLoading || models.length === 0;
  renderModelParameters();
  refreshModelTitle();
}

function setSelectedModel(value, { persist = false } = {}) {
  const selection = reconcileModelSelection(value);
  if (!selection) return;
  if (!availableModels.some((model) => modelId(model) === selection.id)) {
    availableModels = [...availableModels, { id: selection.id, displayName: selection.id }];
  }
  if (persist) persistPreferredModelSelection(selection);
  renderModelOptions(selection);
}

async function loadModels() {
  modelsLoading = true;
  modelCatalogError = "";
  preferredModelSelection = readPreferredModelSelection() ?? configuredModelSelection();
  availableModels = [];
  renderModelOptions(preferredModelSelection);
  try {
    const response = await fetch("/v1/models", { headers: headers() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `读取模型列表失败：HTTP ${response.status}`);
    if (!Array.isArray(data.models) || data.models.length === 0) {
      throw new Error("Cursor 没有返回可用模型");
    }
    availableModels = data.models;
    if (!availableModels.some((model) => modelId(model) === preferredModelSelection?.id)) {
      preferredModelSelection = availableModels.some((model) => modelId(model) === configuredModelSelection()?.id)
        ? configuredModelSelection()
        : { id: modelId(availableModels[0]) };
    }
    preferredModelSelection = reconcileModelSelection(preferredModelSelection);
    persistPreferredModelSelection(preferredModelSelection);
  } catch (error) {
    availableModels = [];
    modelCatalogError = `${error.message}。仍会使用配置中的默认模型。`;
  } finally {
    modelsLoading = false;
    renderModelOptions(preferredModelSelection ?? configuredModelSelection());
  }
}

function setComposerBusy(busy) {
  prompt.disabled = busy;
  send.disabled = busy;
  cancel.disabled = !busy || !currentJobId;
  interruptToggle.disabled = !busy || !currentJobId;
  if (!busy) closeInterruptPanel();
}

function openInterruptPanel() {
  if (!currentJobId) return;
  interruptPanel.classList.add("visible");
  interruptMessage.focus();
}

function closeInterruptPanel() {
  interruptPanel.classList.remove("visible");
  interruptMessage.value = "";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const isDark = theme === "dark";
  themeIcon.textContent = isDark ? "☀" : "☾";
  themeLabel.textContent = isDark ? "浅色" : "深色";
  themeToggle.title = isDark ? "切换到浅色主题" : "切换到深色主题";
  themeToggle.setAttribute("aria-label", themeToggle.title);
}

function setSidebarOpen(open) {
  document.body.classList.toggle("sidebar-open", open);
  mobileMenu.setAttribute("aria-expanded", String(open));
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderMarkdown(text) {
  const source = String(text || "");
  if (!window.marked || !window.DOMPurify) {
    return `<pre>${escapeHtml(source)}</pre>`;
  }
  marked.setOptions({ gfm: true, breaks: true });
  return DOMPurify.sanitize(marked.parse(source), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "form", "input", "button"],
    FORBID_ATTR: ["style", "onerror", "onload"],
  });
}

function parseGitStatus(text) {
  return String(text || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const code = line.slice(0, 2).trim() || "?";
    let filePath = line.slice(3).trim();
    if (filePath.includes(" -> ")) filePath = filePath.split(" -> ").at(-1);
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      try { filePath = JSON.parse(filePath); } catch { /* Keep Git's display form. */ }
    }
    return { code, path: filePath };
  }).filter((entry) => entry.path);
}

function parseDiffFiles(text) {
  const files = [];
  for (const match of String(text || "").matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
    files.push(match[2]);
  }
  return files;
}

function reviewStatusLabel(code) {
  if (code === "??") return "新增";
  if (code.includes("R")) return "重命名";
  if (code.includes("D")) return "删除";
  if (code.includes("A")) return "新增";
  if (code.includes("U")) return "冲突";
  return "修改";
}

function renderCodeReview({ diffText, statusText, issues = [] }) {
  const statusEntries = parseGitStatus(statusText);
  const files = new Map();
  for (const entry of statusEntries) files.set(entry.path, entry);
  for (const filePath of parseDiffFiles(diffText)) {
    if (!files.has(filePath)) files.set(filePath, { code: "M", path: filePath });
  }
  const changedFiles = [...files.values()];
  const diffLines = String(diffText || "").split(/\r?\n/);
  const additions = diffLines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = diffLines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;

  reviewSummary.textContent = changedFiles.length
    ? `${changedFiles.length} 个文件 · +${additions} / -${deletions}`
    : "本次任务没有检测到文件改动";
  reviewFiles.replaceChildren(...(changedFiles.length
    ? changedFiles.map((entry) => {
        const row = document.createElement("div");
        row.className = "review-file";
        const badge = document.createElement("span");
        badge.className = "review-file-state";
        badge.textContent = reviewStatusLabel(entry.code);
        const filePath = document.createElement("code");
        filePath.textContent = entry.path;
        row.append(badge, filePath);
        return row;
      })
    : [Object.assign(document.createElement("div"), {
        className: "review-empty",
        textContent: "没有文件变更",
      })]));

  const untrackedCount = statusEntries.filter((entry) => entry.code === "??").length;
  const notes = [];
  if (untrackedCount) notes.push(`${untrackedCount} 个未跟踪新增文件`);
  if (issues.length) notes.push(...issues);
  reviewNote.hidden = notes.length === 0;
  reviewNote.textContent = notes.join("。");

  reviewDiffTitle.textContent = diffText
    ? `代码差异 · +${additions} / -${deletions}`
    : "代码差异";
  if (!diffText) {
    reviewDiff.replaceChildren(Object.assign(document.createElement("div"), {
      className: "review-empty",
      textContent: changedFiles.length ? "这些文件没有可显示的文本差异。" : "本次任务没有产生代码差异。",
    }));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const line of diffLines) {
    const row = document.createElement("span");
    row.className = "diff-line";
    if (line.startsWith("+++") || line.startsWith("---")) row.classList.add("diff-header");
    else if (line.startsWith("+")) row.classList.add("diff-add");
    else if (line.startsWith("-")) row.classList.add("diff-delete");
    else if (line.startsWith("@@")) row.classList.add("diff-hunk");
    else if (line.startsWith("diff --git") || line.startsWith("new file") || line.startsWith("deleted file")) {
      row.classList.add("diff-file-header");
    }
    row.textContent = `${line || " "}\n`;
    fragment.append(row);
  }
  reviewDiff.replaceChildren(fragment);
}

async function readReviewArtifact(turn, name) {
  const response = await fetch(`/v1/jobs/${turn.id}/artifacts/${encodeURIComponent(name)}`, {
    headers: headers(),
  });
  if (!response.ok) throw new Error(`读取 ${name} 失败：HTTP ${response.status}`);
  return response.text();
}

async function openCodeReview(turn) {
  reviewSummary.textContent = "正在读取代码改动…";
  reviewFiles.replaceChildren();
  reviewDiff.replaceChildren();
  reviewDiffTitle.textContent = "代码差异";
  reviewNote.hidden = true;
  if (!reviewDialog.open) reviewDialog.showModal();

  const artifacts = new Set(turn.artifacts ?? []);
  const [diffResult, statusResult] = await Promise.allSettled([
    artifacts.has("changes.diff") ? readReviewArtifact(turn, "changes.diff") : Promise.resolve(""),
    artifacts.has("git-status.txt") ? readReviewArtifact(turn, "git-status.txt") : Promise.resolve(""),
  ]);
  const issues = [];
  if (diffResult.status === "rejected") issues.push(diffResult.reason.message);
  if (statusResult.status === "rejected") issues.push(statusResult.reason.message);
  renderCodeReview({
    diffText: diffResult.status === "fulfilled" ? diffResult.value : "",
    statusText: statusResult.status === "fulfilled" ? statusResult.value : "",
    issues,
  });
}

function conversationFor(job) {
  return conversations.find((conversation) =>
    (job.agentId && conversation.id === job.agentId) ||
    conversation.turns?.some((turn) => turn.id === job.id)
  );
}

function emptyActivity() {
  return { thinking: "", log: "", thinkingActive: false };
}

function appendThinking(activity, delta) {
  if (delta && !activity.thinkingActive && activity.thinking) activity.thinking += "\n\n";
  activity.thinking += delta;
  // The SDK also sends an empty thinking event when a thinking phase ends.
  activity.thinkingActive = delta.length > 0;
}

function activityFor(turn) {
  const live = activityByJob.get(turn.id);
  if (live && (turn.id === currentJobId || !turn.activity)) return live;
  const activity = emptyActivity();
  if (!turn.activity) return activity;

  // The persisted format adds one prefix and one newline per SDK fragment.
  // Consume only those delimiters so spaces and newlines inside a token survive.
  const entries = turn.activity.replace(/\n$/, "").split(/\n(?=\[(?:思考|状态|工具|任务|汇总|用量|运行|连接|活动|stderr|cursor)(?: |\]))/);
  const logs = [];
  for (const entry of entries) {
    if (entry.startsWith("[思考] ")) {
      appendThinking(activity, entry.slice("[思考] ".length));
    } else {
      logs.push(entry);
      activity.thinkingActive = false;
    }
  }
  activity.log = logs.join("\n");
  activity.thinkingActive = false;
  return activity;
}

function createDisclosure(jobId, kind, content) {
  const thinking = kind === "thinking";
  const details = document.createElement("details");
  details.id = `${kind}-${jobId}`;
  details.className = kind;
  details.hidden = !content;
  const saved = disclosureState.get(details.id) ?? { open: false, top: 0, follow: jobId === currentJobId };
  disclosureState.set(details.id, saved);
  details.open = saved.open;

  const summary = document.createElement("summary");
  const label = document.createElement("span");
  if (thinking) label.className = "thinking-label";
  label.textContent = thinking ? "thinking" : "活动记录（工具、状态）";
  summary.append(label);
  const pre = document.createElement("pre");
  pre.className = thinking ? "thinking-text" : "activity-log";
  pre.append(document.createTextNode(content));
  details.append(summary, pre);

  const restoreScroll = () => {
    if (details.isConnected && details.open) pre.scrollTop = saved.follow ? pre.scrollHeight : saved.top;
  };
  details.addEventListener("toggle", () => {
    if (!details.isConnected) return;
    saved.open = details.open;
    if (details.open) restoreScroll();
  });
  pre.addEventListener("scroll", () => {
    if (!details.isConnected || !details.open) return;
    saved.top = pre.scrollTop;
    saved.follow = pre.scrollHeight - pre.clientHeight - pre.scrollTop <= 4;
  });
  if (details.open) requestAnimationFrame(restoreScroll);
  return details;
}

function updateDisclosure(id, content, thinkingActive = false) {
  const details = document.getElementById(id);
  if (!details) return;
  details.classList.toggle("is-thinking", thinkingActive);
  details.hidden = !content;
  const pre = details.lastElementChild;
  const node = pre.firstChild;
  if (node.length === content.length) return;
  const follow = details.open && pre.scrollHeight - pre.clientHeight - pre.scrollTop <= 4;
  node.appendData(content.slice(node.length));
  if (follow) pre.scrollTop = pre.scrollHeight;
}

function addActivity(jobId, text, kind = "event") {
  if (!jobId) return;
  const activity = activityByJob.get(jobId) ?? emptyActivity();
  activityByJob.set(jobId, activity);
  if (kind === "thinking") {
    appendThinking(activity, text);
  } else if (text) {
    if (activity.log && !activity.log.endsWith("\n") && !text.startsWith("\n")) activity.log += "\n";
    activity.log += text;
    activity.thinkingActive = false;
  }
  if (activityFrame) return;
  activityFrame = requestAnimationFrame(() => {
    activityFrame = 0;
    const id = currentJobId;
    const current = activityByJob.get(id);
    if (!current) return;
    const follow = isTranscriptNearBottom();
    updateDisclosure(`thinking-${id}`, current.thinking, current.thinkingActive);
    updateDisclosure(`activity-${id}`, current.log);
    if (follow) transcript.scrollTop = transcript.scrollHeight;
  });
}

function createTurnElement(turn) {
  const article = document.createElement("article");
  article.className = "turn";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "C";
  const body = document.createElement("div");
  body.className = "turn-body";

  const promptElement = document.createElement("div");
  promptElement.className = "user-message";
  promptElement.textContent = turn.prompt || "";
  body.append(promptElement);

  const activity = activityFor(turn);
  const thinking = createDisclosure(turn.id, "thinking", activity.thinking);
  thinking.classList.toggle("is-thinking", turn.id === currentJobId && activity.thinkingActive);
  body.append(thinking, createDisclosure(turn.id, "activity", activity.log));

  if (turn.finalReport) {
    const answer = document.createElement("div");
    answer.className = "answer";
    answer.innerHTML = renderMarkdown(turn.finalReport);
    body.append(answer);
  }

  const footer = document.createElement("div");
  footer.className = "turn-footer";
  const state = document.createElement("span");
  const turnModel = compactModelDescription(turn.model);
  state.textContent = `${statusLabel(turn.status)}${turnModel ? ` · ${turnModel}` : ""} · ${new Date(turn.finishedAt ?? turn.createdAt).toLocaleString()}`;
  footer.append(state);
  const codeArtifacts = new Set(["changes.diff", "git-status.txt"]);
  if ((turn.artifacts ?? []).some((artifact) => codeArtifacts.has(artifact)) || turn.metadata?.git?.isGit) {
    const reviewButton = document.createElement("button");
    reviewButton.type = "button";
    reviewButton.className = "review-button";
    reviewButton.textContent = "审查代码改动";
    reviewButton.addEventListener("click", () => void openCodeReview(turn));
    footer.append(reviewButton);
  }
  for (const artifact of turn.artifacts ?? []) {
    if (codeArtifacts.has(artifact)) continue;
    const link = document.createElement("a");
    link.href = `/v1/jobs/${turn.id}/artifacts/${encodeURIComponent(artifact)}`;
    link.textContent = artifact;
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const response = await fetch(link.href, { headers: { authorization: `Bearer ${authToken}` } });
      if (!response.ok) return showError(`读取 ${artifact} 失败`);
      const content = await response.text();
      if (artifact === "final.md") {
        turn.finalReport = content;
        renderConversation();
      }
    });
    footer.append(link);
  }
  body.append(footer);
  article.append(avatar, body);
  return article;
}

function activeConversation() {
  return conversations.find((conversation) => conversation.id === activeConversationId);
}

function createConversationButton(entry) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `conversation${entry.id === activeConversationId ? " active" : ""}`;
  const title = document.createElement("div");
  title.className = "conversation-title";
  title.textContent = entry.title;
  const metaElement = document.createElement("div");
  metaElement.className = "conversation-meta";
  metaElement.textContent = `${entry.turns} 轮 · ${statusLabel(entry.turn?.status)}`;
  button.title = `${entry.title}\n${entry.workspace}\n${metaElement.textContent}`;
  button.append(title, metaElement);
  button.addEventListener("click", () => selectConversation(entry.id));
  return button;
}

function renderConversations() {
  if (activeConversationId && !activeConversation()) {
    activeConversationId = undefined;
  }
  const groups = new Map();
  for (const conversation of conversations) {
    const pathValue = conversation.workspace || workspace.value || "未指定工作区";
    if (!groups.has(pathValue)) groups.set(pathValue, []);
    groups.get(pathValue).push(conversation);
  }
  conversationCount.textContent = conversations.length ? `${conversations.length} 个` : "";
  if (groups.size === 0) {
    const empty = document.createElement("div");
    empty.className = "conversation-empty";
    empty.textContent = "还没有会话";
    conversationsList.replaceChildren(empty);
    return;
  }
  const currentWorkspace = activeConversation()?.workspace ?? workspace.value;
  const groupElements = [...groups.entries()].map(([pathValue, items]) => {
    const group = document.createElement("details");
    group.className = "workspace-group";
    const storageKey = `${STORAGE_GROUP_PREFIX}${pathValue.toLowerCase()}`;
    const stored = groupOpenState.get(storageKey);
    group.open = stored ?? (pathValue === currentWorkspace || items.some((item) => item.id === activeConversationId));
    group.addEventListener("toggle", () => {
      if (!group.isConnected) return;
      groupOpenState.set(storageKey, group.open);
    });
    const summary = document.createElement("summary");
    summary.title = pathValue;
    const name = document.createElement("span");
    name.className = "workspace-group-name";
    name.textContent = pathValue;
    const count = document.createElement("span");
    count.className = "workspace-group-count";
    count.textContent = String(items.length);
    summary.append(name, count);
    const itemsElement = document.createElement("div");
    itemsElement.className = "workspace-group-items";
    itemsElement.append(...items.map((conversation) => createConversationButton({
      id: conversation.id,
      title: conversation.title || "未命名对话",
      turns: conversation.turns.length,
      turn: conversation.turns.at(-1),
      workspace: pathValue,
    })));
    group.append(summary, itemsElement);
    return group;
  });
  conversationsList.replaceChildren(...groupElements);
}

function normalizedWorkspace(value) {
  return String(value || "").replace(/[\\/]+$/, "").toLowerCase();
}

function savedWorkspacePaths() {
  const all = [...(meta?.allowedWorkspaces ?? []), ...JSON.parse(localStorage.getItem(STORAGE_WORKSPACES) || "[]")];
  const unique = new Map();
  for (const value of all) {
    if (typeof value === "string" && value.trim()) unique.set(normalizedWorkspace(value), value);
  }
  return [...unique.values()];
}

function saveWorkspacePreferences(items) {
  try { localStorage.setItem(STORAGE_WORKSPACES, JSON.stringify(items)); } catch { /* Server configuration remains authoritative. */ }
}

function requestWorkspaceRemoval(pathValue) {
  const items = savedWorkspacePaths();
  if (items.length <= 1) {
    showError("至少需要保留一个工作区。");
    return;
  }
  pendingWorkspaceRemoval = pathValue;
  removeWorkspacePath.textContent = pathValue;
  removeWorkspaceDialog.showModal();
}

function renderWorkspaces() {
  const initial = workspace.value;
  const items = savedWorkspacePaths();
  if (!items.includes(initial) && items[0]) workspace.value = items[0];
  workspace.replaceChildren(...items.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    return option;
  }));
  if (items.includes(initial)) workspace.value = initial;
  workspaceList.replaceChildren(...items.map((value) => {
    const row = document.createElement("div");
    row.className = `workspace-manage${value === workspace.value ? " active" : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-item";
    button.textContent = value;
    button.title = `${value}\n点击选择，长按移除`;
    button.addEventListener("click", () => {
      workspace.value = value;
      renderWorkspaces();
    });
    let longPressTimer;
    const cancelLongPress = () => clearTimeout(longPressTimer);
    button.addEventListener("pointerdown", () => {
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressTimer = undefined;
        navigator.vibrate?.(20);
        requestWorkspaceRemoval(value);
      }, 650);
    });
    button.addEventListener("pointerup", cancelLongPress);
    button.addEventListener("pointerleave", cancelLongPress);
    button.addEventListener("pointercancel", cancelLongPress);
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      requestWorkspaceRemoval(value);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "workspace-remove";
    remove.title = `移除工作区 ${value}`;
    remove.setAttribute("aria-label", remove.title);
    remove.textContent = "×";
    remove.addEventListener("click", () => requestWorkspaceRemoval(value));
    row.append(button, remove);
    return row;
  }));
}

function explorerIsOpen() {
  return explorer.classList.contains("open");
}

function setExplorerOpen(open) {
  explorer.classList.toggle("open", open);
  mainArea.classList.toggle("with-explorer", open);
  document.body.classList.toggle("explorer-open", open);
  explorerToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    setSidebarOpen(false);
    void loadFileDirectories();
  } else {
    document.body.classList.remove("explorer-open");
  }
}

function fileChanged(pathValue) {
  const prefix = pathValue + "/";
  return [...changedFilePaths].some((changed) =>
    changed === pathValue || changed.startsWith(prefix)
  );
}

function fileIcon(entry, open) {
  if (entry.type === "directory") return open ? "−" : "+";
  if (entry.type === "symlink") return "↗";
  return "·";
}

function renderFileLines(lines, fragment) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = document.createElement("span");
    line.className = "file-line";
    const number = document.createElement("span");
    number.className = "line-number";
    number.textContent = String(index + 1);
    const code = document.createElement("span");
    code.className = "line-code";
    code.textContent = lines[index] || " ";
    line.append(number, code);
    fragment.append(line);
  }
}

function appendFileEntries(container, directoryPath) {
  const state = getFileDirectoryData(directoryPath);
  if (!getFileDirectoryData(directoryPath)) {
    if (!explorerIsOpen()) return;
    const loading = document.createElement("div");
    loading.className = "file-empty";
    loading.textContent = loadingFileDirectories.has(normalizedWorkspace(workspace.value) + "\0" + directoryPath) ? "读取中…" : "展开以读取";
    container.append(loading);
    return;
  }
  const error = fileDirectoryErrors.get(directoryPath);
  if (error) {
    const row = document.createElement("div");
    row.className = "file-error";
    row.textContent = error;
    container.append(row);
    return;
  }
  if (!state?.entries?.length) {
    if (directoryPath) {
      const empty = document.createElement("div");
      empty.className = "file-empty";
      empty.textContent = "此目录没有可显示文件";
      container.append(empty);
      return;
    }
    const empty = document.createElement("div");
    empty.className = "file-empty";
    empty.textContent = "此目录没有可显示文件";
    container.append(empty);
    return;
  }
  const parentDepth = directoryPath ? directoryPath.split("/").length : 0;
  for (const entry of state.entries) {
    const changed = fileChanged(entry.path);
    const open = entry.type === "directory" && expandedFileDirectories.has(entry.path);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "file-row" + (entry.path === activeFilePath ? " active" : "") + (changed ? " changed" : "") + (entry.previewable === false ? " disabled" : "");
    row.title = entry.path + (entry.reason ? " (" + entry.reason + ")" : "");
    row.style.paddingLeft = (7 + parentDepth * 13) + "px";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = fileIcon(entry, open);
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = entry.name;
    row.append(icon, name);
    if (changed) {
      const badge = document.createElement("span");
      badge.className = "file-badge";
      badge.textContent = "M";
      row.append(badge);
    }
    if (entry.type === "directory") {
      row.addEventListener("click", () => {
        activeFileDirectory = entry.path;
        if (expandedFileDirectories.has(entry.path)) expandedFileDirectories.delete(entry.path);
        else expandedFileDirectories.add(entry.path);
        void loadFileDirectory(entry.path).then(renderFileTree);
      });
    } else if (entry.previewable === false) {
      row.disabled = true;
    } else {
      row.addEventListener("click", () => void openWorkspaceFile(entry.path));
    }
    container.append(row);
    if (entry.type === "directory" && open) {
      const children = document.createElement("div");
      children.className = "file-children";
      appendFileEntries(children, entry.path);
      container.append(children);
    }
  }
}

function renderFileTree() {
  if (!explorerIsOpen()) return;
  if (!workspace.value) {
    fileTree.replaceChildren(Object.assign(document.createElement("div"), {
      className: "file-empty",
      textContent: "请先选择工作区",
    }));
    return;
  }
  explorerWorkspace.textContent = workspace.value;
  explorerWorkspace.title = workspace.value;
  const root = document.createElement("div");
  appendFileEntries(root, "");
  fileTree.replaceChildren(root);
}

async function loadFileDirectory(directoryPath = "") {
  if (!explorerIsOpen() || !workspace.value) return;
  const key = normalizedWorkspace(workspace.value) + "\0" + directoryPath;
  if (fileDirectoryCache.has(key) || loadingFileDirectories.has(key)) {
    renderFileTree();
    return;
  }
  loadingFileDirectories.add(key);
  renderFileTree();
  try {
    const response = await fetch("/v1/files?workspace=" + encodeURIComponent(workspace.value) + "&path=" + encodeURIComponent(directoryPath), {
      headers: headers(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "读取目录失败：HTTP " + response.status);
    fileDirectoryCache.set(key, data);
    fileDirectoryErrors.delete(key);
  } catch (error) {
    fileDirectoryErrors.set(key, error.message);
  } finally {
    loadingFileDirectories.delete(key);
    renderFileTree();
  }
}

function getFileDirectoryData(directoryPath) {
  return fileDirectoryCache.get(normalizedWorkspace(workspace.value) + "\0" + directoryPath);
}

async function loadFileDirectories() {
  await loadFileDirectory("");
  for (const directoryPath of [...expandedFileDirectories]) {
    if (directoryPath) await loadFileDirectory(directoryPath);
  }
}

function renderPreviewFragment(content, truncated) {
  const fragment = document.createDocumentFragment();
  if (truncated) {
    const notice = document.createElement("div");
    notice.className = "file-info";
    notice.textContent = "文件较大，仅显示前 1.5 MB。预览不会修改原文件。";
    fragment.append(notice);
  }
  renderFileLines(String(content || "").split(/\r?\n/), fragment);
  return fragment;
}

function renderMarkdownPreview(content, truncated) {
  const wrapper = document.createElement("div");
  wrapper.className = "file-markdown";
  if (truncated) {
    const notice = document.createElement("div");
    notice.className = "file-info";
    notice.textContent = "文件较大，仅渲染前 1.5 MB。预览不会修改原文件。";
    wrapper.append(notice);
  }
  const rendered = document.createElement("div");
  rendered.innerHTML = renderMarkdown(content);
  wrapper.append(rendered);
  fileView.classList.add("markdown-preview");
  fileView.replaceChildren(wrapper);
}

function updateFilePreviewMode() {
  const isMarkdown = activeFilePreview?.language === "markdown";
  filePreviewMode.hidden = !isMarkdown;
  if (!isMarkdown) return;
  filePreviewMode.textContent = markdownSourceMode ? "格式化预览" : "查看源码";
  filePreviewMode.title = markdownSourceMode ? "切换回格式化 Markdown" : "显示 Markdown 原始文本";
}

function renderFilePreview({ content = "", name = "选择文件进行预览", meta = "", info = "", language = "text", truncated = false }) {
  filePreviewTitle.textContent = name;
  filePreviewTitle.title = name;
  filePreviewMeta.textContent = meta;
  fileView.classList.remove("markdown-preview");
  updateFilePreviewMode();
  if (info) {
    fileView.replaceChildren(Object.assign(document.createElement("div"), {
      className: "file-info",
      textContent: info,
    }));
    return;
  }
  if (!content) {
    fileView.replaceChildren(Object.assign(document.createElement("div"), {
      className: "file-welcome",
      textContent: language === "markdown" ? "这是一个空的 Markdown 文档" : "文本文件会以只读方式显示",
    }));
    return;
  }
  if (language === "markdown" && !markdownSourceMode) {
    renderMarkdownPreview(content, truncated);
  } else {
    fileView.replaceChildren(renderPreviewFragment(content, truncated));
  }
  fileView.scrollTop = 0;
}

function renderActiveFilePreview() {
  if (!activeFilePreview) {
    fileView.classList.remove("markdown-preview");
    filePreviewMode.hidden = true;
    renderFilePreview();
    return;
  }
  renderFilePreview(activeFilePreview);
}

async function openWorkspaceFile(pathValue) {
  activeFilePath = pathValue;
  renderFileTree();
  filePreviewTitle.textContent = pathValue;
  filePreviewMeta.textContent = "读取中…";
  try {
    const response = await fetch("/v1/file?workspace=" + encodeURIComponent(workspace.value) + "&path=" + encodeURIComponent(pathValue), {
      headers: headers(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "读取文件失败：HTTP " + response.status);
    if (activeFilePath !== pathValue) return;
    const bytes = data.size >= 1024 ? (data.size / 1024).toFixed(data.size < 10240 ? 1 : 0) + " KB" : data.size + " B";
    const truncated = data.truncated ? " · 仅显示前 1.5 MB" : "";
    filePreviewTitle.textContent = pathValue;
    filePreviewTitle.title = pathValue;
    activeFilePreview = {
      content: data.content,
      name: pathValue,
      meta: data.language + " · " + data.encoding + " · " + bytes + truncated,
      language: data.language,
      truncated: data.truncated,
    };
    markdownSourceMode = false;
    renderFilePreview(activeFilePreview);
  } catch (error) {
    if (activeFilePath !== pathValue) return;
    filePreviewMeta.textContent = "";
    activeFilePreview = null;
    markdownSourceMode = false;
    filePreviewMode.hidden = true;
    renderFilePreview({ name: pathValue, info: error.message });
  }
}

function invalidateFileExplorer() {
  fileDirectoryCache.clear();
  fileDirectoryErrors.clear();
  loadingFileDirectories.clear();
  activeFilePath = undefined;
  activeFileDirectory = undefined;
  activeFilePreview = null;
  markdownSourceMode = false;
  filePreviewMode.hidden = true;
  renderFilePreview();
}

async function refreshFileExplorer() {
  if (!explorerIsOpen() || !workspace.value) return;
  fileDirectoryCache.clear();
  fileDirectoryErrors.clear();
  const openFile = activeFilePath;
  await loadFileDirectories();
  if (openFile) await openWorkspaceFile(openFile);
  renderFileTree();
}

function updateChangedFilesFromTurn(turn) {
  const artifacts = new Set(turn?.artifacts ?? []);
  if (!artifacts.has("git-status.txt")) {
    changedFilePaths = new Set();
    renderFileTree();
    return;
  }
  void readReviewArtifact(turn, "git-status.txt").then((status) => {
    changedFilePaths = new Set(parseGitStatus(status).map((entry) => entry.path));
    renderFileTree();
  }).catch(() => {
    changedFilePaths = new Set();
  });
}

function syncExplorerWorkspace() {
  invalidateFileExplorer();
  changedFilePaths = new Set();
  if (explorerIsOpen()) void loadFileDirectories();
  syncChangedFilesFromLatestTurn();
}

function syncChangedFilesFromLatestTurn() {
  const latestTurn = activeConversation()?.turns.at(-1) ?? currentTurn;
  if (latestTurn) updateChangedFilesFromTurn(latestTurn);
}

function isElementNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= TRANSCRIPT_FOLLOW_THRESHOLD;
}

function isTranscriptNearBottom() {
  return isElementNearBottom(transcript);
}

function scrollTranscriptToBottom() {
  const scroll = () => {
    transcript.scrollTop = transcript.scrollHeight;
  };
  scroll();
  requestAnimationFrame(() => {
    scroll();
    requestAnimationFrame(scroll);
  });
}

function renderConversation({ follow = false } = {}) {
  const conversation = activeConversation();
  if (explorerIsOpen()) renderFileTree();
  welcome.hidden = Boolean(conversation) && conversation.turns.length > 0;
  currentTitle.textContent = conversation?.title ?? "新对话";
  const selected = conversation?.workspace ?? workspace.value;
  currentWorkspace.textContent = selected;
  const turns = conversation?.turns ?? [];
  // A click can change the native open property before its toggle event fires.
  for (const details of turnsElement.querySelectorAll("details.thinking, details.activity")) {
    const saved = disclosureState.get(details.id);
    if (saved) saved.open = details.open;
  }
  turnsElement.replaceChildren(...turns.map(createTurnElement));
  if (currentTurn && !turns.some((turn) => turn.id === currentTurn.id)) {
    turnsElement.append(createTurnElement(currentTurn));
  }
  renderConversations();
  if (follow) scrollTranscriptToBottom();
}

async function refreshConversations({ follow = false } = {}) {
  const response = await fetch("/v1/conversations", { headers: headers() });
  if (!response.ok) throw new Error(`读取会话失败：HTTP ${response.status}`);
  conversations = (await response.json()).conversations;
  renderConversation({ follow });
}

function selectConversation(id) {
  monitorController?.abort();
  activeConversationId = id;
  currentTurn = null;
  const conversation = activeConversation();
  const latest = conversation?.turns.at(-1);
  if (modelId(latest?.model)) setSelectedModel(latest.model);
  if (conversation?.workspace) {
    workspace.value = conversation.workspace;
    renderWorkspaces();
  }
  if (latest && ["queued", "running"].includes(latest.status)) {
    currentJobId = latest.id;
    setStatus(latest.status, latest.status === "running" ? "运行中" : "排队中");
    setComposerBusy(true);
    void monitor(currentJobId);
  } else {
    currentJobId = undefined;
    setComposerBusy(false);
    setStatus(latest?.status ?? "idle", statusLabel(latest?.status));
  }
  setSidebarOpen(false);
  renderConversation({ follow: true });
  changedFilePaths = new Set();
  syncChangedFilesFromLatestTurn();
}

function createNewConversation() {
  monitorController?.abort();
  activeConversationId = undefined;
  currentJobId = undefined;
  currentTurn = null;
  setSelectedModel(preferredModelSelection ?? configuredModelSelection());
  setComposerBusy(false);
  setStatus("idle", "就绪");
  renderConversation();
  prompt.focus();
}

function readableActivity(event) {
  if (event.type === "activity") {
    if (event.kind === "thinking") return event.text ?? "";
    if (event.kind === "status") return `[状态] ${event.status}${event.text ? ` ${event.text}` : ""}`;
    if (event.kind === "usage") return `[用量] ${JSON.stringify(event.usage ?? {})}`;
    if (event.kind === "run") return `[运行] agent=${event.agentId ?? ""} run=${event.runId ?? ""}`;
    if (event.kind === "tool") {
      const args = event.args === undefined ? "" : ` ${JSON.stringify(event.args)}`;
      const result = event.result === undefined ? "" : ` -> ${JSON.stringify(event.result)}`;
      return `[工具 ${event.status ?? ""}] ${event.name ?? ""}${args}${result}`;
    }
    if (event.kind === "task") return `[任务 ${event.status ?? ""}] ${event.text ?? ""}`;
    if (event.kind === "summary") return `[汇总 ${event.status ?? ""}] ${event.text ?? ""}`;
    if (event.kind === "system") return `[连接] agent=${event.agentId ?? ""} run=${event.runId ?? ""}${event.model ? ` model=${event.model}` : ""}`;
    if (event.kind === "assistant") return "";
    return `[活动] ${JSON.stringify(event)}`;
  }
  if (event.type === "stderr") return `[stderr] ${event.text ?? ""}`;
  return event.text ?? "";
}

function handleEvent(event) {
  if (!currentJobId || event.type === "queued") return;
  if (event.type === "started") {
    setStatus("running", "运行中");
    if (currentTurn?.id === currentJobId) currentTurn.status = "running";
    renderConversation({ follow: isTranscriptNearBottom() });
  }
  if (event.type === "stdout" || event.type === "stderr" || event.type === "activity") {
    const text = readableActivity(event);
    if (text || event.kind === "thinking") addActivity(currentJobId, text, event.kind);
  }
  if (event.type === "interrupt") {
    addActivity(currentJobId, `\n[中断] ${event.text ?? ""}${event.outcome ? ` (${event.outcome})` : ""}`);
    closeInterruptPanel();
  }
  if (event.type === "done") {
    const followTranscript = isTranscriptNearBottom();
    const completedJobId = currentJobId;
    const activity = activityByJob.get(completedJobId);
    if (activity) activity.thinkingActive = false;
    document.getElementById(`thinking-${completedJobId}`)?.classList.remove("is-thinking");
    if (event.status === "cancelled") {
      currentJobId = undefined;
      currentTurn = null;
      setComposerBusy(false);
      void refreshConversations()
        .then(() => {
          const conversation = conversations.find((item) =>
            item.turns?.some((turn) => turn.id === completedJobId)
          );
          if (conversation) activeConversationId = conversation.id;
          renderConversation({ follow: isTranscriptNearBottom() });
          void refreshFileExplorer();
        })
        .catch((error) => showError(error.message));
      return;
    }
    setStatus(event.status, statusLabel(event.status));
    setComposerBusy(false);
    currentTurn = {
      id: completedJobId,
      prompt: currentTurn?.prompt ?? prompt.value,
      status: event.status,
      finalReport: event.finalReport ?? null,
      artifacts: event.artifacts ?? [],
      model: normalizeModelSelection(currentTurn?.model) ?? normalizeModelSelection(event.metadata?.model) ?? currentModelSelection(),
      metadata: event.metadata ?? {},
      createdAt: currentTurn?.createdAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    renderConversation({ follow: followTranscript });
    updateChangedFilesFromTurn(currentTurn);
    void refreshFileExplorer();
    void refreshConversations()
      .then(() => {
        const conversation = conversations.find((item) =>
          item.turns?.some((turn) => turn.id === completedJobId)
        );
        if (conversation) activeConversationId = conversation.id;
        renderConversation({ follow: isTranscriptNearBottom() });
        updateChangedFilesFromTurn(conversation?.turns.find((turn) => turn.id === completedJobId) ?? currentTurn);
        void refreshFileExplorer();
      })
      .catch((error) => showError(error.message));
  }
}

function parseEvents(block) {
  const eventType = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
  const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart()).join("\n");
  if (!data) return;
  try { handleEvent(JSON.parse(data)); }
  catch { addActivity(currentJobId, `[stream] ${data}\n`); }
}

async function monitor(jobId) {
  monitorController?.abort();
  monitorController = new AbortController();
  const controller = monitorController;
  activityByJob.set(jobId, emptyActivity());
  let after = 0;
  try {
    while (!controller.signal.aborted) {
      const response = await fetch(`/v1/jobs/${jobId}/events?after=${after}`, {
        headers: { authorization: `Bearer ${authToken}` }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`读取任务事件失败：HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = ""; let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (controller.signal.aborted || currentJobId !== jobId) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          const id = Number(block.split(/\r?\n/).find((line) => line.startsWith("id:"))?.slice(3));
          if (Number.isFinite(id)) after = Math.max(after, id);
          parseEvents(block);
          if (block.includes("event: done")) finished = true;
        }
      }
      if (finished || controller.signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      const activity = activityByJob.get(jobId);
      if (activity) activity.thinkingActive = false;
      document.getElementById(`thinking-${jobId}`)?.classList.remove("is-thinking");
      showError(error.message);
    }
  } finally {
    if (monitorController === controller) cancel.disabled = true;
  }
}

async function sendPrompt() {
  showError("");
  const text = prompt.value.trim();
  if (!text) { showError("请输入任务指令。"); prompt.focus(); return; }
  setComposerBusy(true);
  setStatus("queued", "提交中");
  currentTurn = {
    id: "pending",
    prompt: text,
    status: "queued",
    finalReport: null,
    artifacts: [],
    model: currentModelSelection(),
    createdAt: new Date().toISOString(),
  };
  renderConversation({ follow: true });
  try {
    const conversation = activeConversation();
    const body = {
      workspace: conversation?.workspace ?? workspace.value,
      prompt: text,
      timeoutSeconds: 1800,
      ...(selectedModel ? { model: currentModelSelection() } : {}),
      idempotencyKey: randomUuid(),
      ...(conversation?.agentId ? { agentId: conversation.agentId } : {}),
    };
    const response = await fetch("/v1/jobs", { method: "POST", headers: headers(), body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `提交失败：HTTP ${response.status}`);
    currentJobId = data.job.id;
    setComposerBusy(true);
    currentTurn.id = currentJobId;
    currentTurn.model = normalizeModelSelection(data.job.model) ?? currentModelSelection();
    prompt.value = "";
    renderConversation({ follow: true });
    void monitor(currentJobId);
  } catch (error) {
    setStatus("failed", "失败");
    showError(error.message);
    currentTurn = null;
    setComposerBusy(false);
    renderConversation();
  }
}

async function fetchMeta() {
  const response = await fetch("/v1/meta", { headers: headers() });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `读取配置失败：HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function initializeBridge(metaData = meta) {
  meta = metaData;
  void loadModels();
  renderWorkspaces();
  await refreshConversations();
}

async function loadMeta() {
  try {
    const tokenResponse = await fetch("/local-token");
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (tokenResponse.ok && tokenData.local && tokenData.token) authToken = tokenData.token;
  } catch {
    authToken = "";
  }
  if (!authToken) {
    showRemoteAuth();
    return;
  }
  try {
    await initializeBridge(await fetchMeta());
  } catch (error) {
    if (error.status === 401) {
      authToken = "";
      showRemoteAuth();
      return;
    }
    throw error;
  }
}

remoteAuthToken.addEventListener("input", () => showRemoteAuthError(""));
reviewClose.addEventListener("click", () => reviewDialog.close());
reviewDialog.addEventListener("click", (event) => {
  if (event.target === reviewDialog) reviewDialog.close();
});
remoteAuthDialog.addEventListener("cancel", (event) => event.preventDefault());
remoteAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const candidate = remoteAuthToken.value.trim();
  if (!candidate) {
    showRemoteAuthError("请输入 Bridge API Token。");
    remoteAuthToken.focus();
    return;
  }
  remoteAuthSubmit.disabled = true;
  remoteAuthSubmit.textContent = "连接中…";
  showRemoteAuthError("");
  authToken = candidate;
  try {
    const metaData = await fetchMeta();
    await initializeBridge(metaData);
    remoteAuthToken.value = "";
    remoteAuthDialog.close();
  } catch (error) {
    if (error.status === 401) authToken = "";
    if (!remoteAuthDialog.open) showRemoteAuth();
    showRemoteAuthError(error.status === 401 ? "Token 无效，请检查后重试。" : error.message);
    remoteAuthToken.select();
  } finally {
    remoteAuthSubmit.disabled = false;
    remoteAuthSubmit.textContent = "连接";
  }
});

newConversation.addEventListener("click", createNewConversation);
modelSelect.addEventListener("change", () => setSelectedModel(modelSelect.value, { persist: true }));
send.addEventListener("click", sendPrompt);
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); void sendPrompt();
  }
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 260)}px`;
});
cancel.addEventListener("click", async () => {
  if (!currentJobId) return;
  cancel.disabled = true;
  const response = await fetch(`/v1/jobs/${currentJobId}/cancel`, { method: "POST", headers: headers() });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    showError(data.error || `停止任务失败：HTTP ${response.status}`);
    cancel.disabled = false;
    return;
  }
  setStatus("cancelled", "已停止");
});
interruptToggle.addEventListener("click", openInterruptPanel);
interruptClose.addEventListener("click", closeInterruptPanel);
interruptMessage.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    interruptSubmit.click();
  }
});
interruptSubmit.addEventListener("click", async () => {
  const message = interruptMessage.value.trim();
  if (!currentJobId || !message) {
    interruptMessage.focus();
    return;
  }
  interruptSubmit.disabled = true;
  interruptSubmit.textContent = "发送中…";
  try {
    const response = await fetch(`/v1/jobs/${currentJobId}/interrupt`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ message }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `发送中断失败：HTTP ${response.status}`);
    addActivity(currentJobId, `\n[中断] ${message}`);
    closeInterruptPanel();
    renderConversation();
  } catch (error) {
    showError(error.message);
  } finally {
    interruptSubmit.disabled = false;
    interruptSubmit.textContent = "发送中断";
  }
});
workspace.addEventListener("change", () => {
  if (activeConversation()) {
    monitorController?.abort();
    activeConversationId = undefined;
    currentJobId = undefined;
    currentTurn = null;
    cancel.disabled = true;
    setStatus("idle", "就绪");
  }
  renderWorkspaces(); renderConversation();
  syncExplorerWorkspace();
});
function closeFolderPicker() {
  folderPicker.classList.remove("visible");
}

async function browseFolder(pathValue = "") {
  showError("");
  browseWorkspace.disabled = true;
  try {
    const response = await fetch(`/local-workspace-browse?path=${encodeURIComponent(pathValue)}`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `读取目录失败：HTTP ${response.status}`);
    browseState = data;
    folderPicker.classList.add("visible");
    folderLocation.textContent = data.path || "此电脑";
    folderLocation.title = data.path || "此电脑";
    folderUp.disabled = !data.path;
    folderUseCurrent.disabled = !data.path;
    folderUseCurrent.textContent = data.path ? `选择此文件夹（${data.path.split(/[\\/]/).filter(Boolean).at(-1) || data.path}）` : "选择当前文件夹";
    folderList.replaceChildren(...(data.entries.length ? data.entries.map((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "folder-entry";
      button.title = entry.path;
      const icon = document.createElement("span");
      icon.className = "folder-entry-icon";
      icon.textContent = "▸";
      const name = document.createElement("span");
      name.textContent = entry.name;
      button.append(icon, name);
      button.addEventListener("click", () => {
        void browseFolder(entry.path);
      });
      return button;
    }) : [Object.assign(document.createElement("div"), { className: "folder-picker-empty", textContent: "此目录没有子文件夹" })]));
  } catch (error) {
    showError(error.message);
  } finally {
    browseWorkspace.disabled = false;
  }
}

addWorkspace.addEventListener("click", () => { workspacePath.value = ""; closeFolderPicker(); workspaceDialog.showModal(); workspacePath.focus(); });
browseWorkspace.addEventListener("click", () => browseFolder(workspacePath.value.trim() || (meta?.allowedWorkspaces?.[0] ?? "")));
folderUp.addEventListener("click", () => { if (browseState.parent) void browseFolder(browseState.parent); });
folderUseCurrent.addEventListener("click", () => {
  if (!browseState.path) return;
  workspacePath.value = browseState.path;
  folderLocation.textContent = "已选择：" + browseState.path;
  workspacePath.focus();
});
folderClose.addEventListener("click", closeFolderPicker);
document.querySelector("#cancel-workspace").addEventListener("click", () => workspaceDialog.close());
workspaceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = workspacePath.value.trim().replace(/[\\/]+$/, "");
  if (!value) return;
  addWorkspaceSubmit.disabled = true;
  addWorkspaceSubmit.textContent = "添加中…";
  showError("");
  void fetch("/local-workspaces", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ path: value }),
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `添加工作区失败：HTTP ${response.status}`);
    meta.allowedWorkspaces = data.allowedWorkspaces;
    saveWorkspacePreferences([...savedWorkspacePaths().filter((item) => normalizedWorkspace(item) !== normalizedWorkspace(data.workspace)), data.workspace]);
    workspaceDialog.close();
    workspace.value = data.workspace;
    renderWorkspaces(); renderConversation();
    syncExplorerWorkspace();
    setSidebarOpen(false);
  }).catch((error) => {
    showError(error.message);
  }).finally(() => {
    addWorkspaceSubmit.disabled = false;
    addWorkspaceSubmit.textContent = "添加";
  });
});

document.querySelector("#cancel-remove-workspace").addEventListener("click", () => {
  pendingWorkspaceRemoval = undefined;
  removeWorkspaceDialog.close();
});
confirmRemoveWorkspace.addEventListener("click", async () => {
  const pathValue = pendingWorkspaceRemoval;
  if (!pathValue) return;
  confirmRemoveWorkspace.disabled = true;
  confirmRemoveWorkspace.textContent = "移除中…";
  showError("");
  try {
    if (meta.allowedWorkspaces.some((item) => normalizedWorkspace(item) === normalizedWorkspace(pathValue))) {
      const response = await fetch("/local-workspaces", {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify({ path: pathValue }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `移除工作区失败：HTTP ${response.status}`);
      meta.allowedWorkspaces = data.allowedWorkspaces;
    }
    const remaining = savedWorkspacePaths().filter((item) => normalizedWorkspace(item) !== normalizedWorkspace(pathValue));
    saveWorkspacePreferences(remaining);
    const removedWorkspaceKey = normalizedWorkspace(pathValue);
    const removedTurns = conversations
      .filter((conversation) => normalizedWorkspace(conversation.workspace) === removedWorkspaceKey)
      .flatMap((conversation) => conversation.turns ?? []);
    const removedTurnIds = new Set(removedTurns.map((turn) => turn.id));
    const activeWasRemoved = normalizedWorkspace(activeConversation()?.workspace) === removedWorkspaceKey;
    conversations = conversations.filter(
      (conversation) => normalizedWorkspace(conversation.workspace) !== removedWorkspaceKey,
    );
    for (const turnId of removedTurnIds) {
      activityByJob.delete(turnId);
      disclosureState.delete(`thinking-${turnId}`);
      disclosureState.delete(`activity-${turnId}`);
    }
    removeWorkspaceDialog.close();
    pendingWorkspaceRemoval = undefined;
    if (activeWasRemoved) activeConversationId = undefined;
    if (activeWasRemoved || normalizedWorkspace(workspace.value) === removedWorkspaceKey || removedTurnIds.has(currentJobId)) {
      monitorController?.abort();
      activeConversationId = undefined;
      currentJobId = undefined;
      currentTurn = null;
      workspace.value = remaining[0] ?? "";
      setComposerBusy(false);
      setStatus("idle", "就绪");
    }
    renderWorkspaces();
    renderConversation();
    syncExplorerWorkspace();
  } catch (error) {
    showError(error.message);
  } finally {
    confirmRemoveWorkspace.disabled = false;
    confirmRemoveWorkspace.textContent = "移除";
  }
});
removeWorkspaceForm.addEventListener("submit", (event) => event.preventDefault());

mobileMenu.addEventListener("click", () => setSidebarOpen(!document.body.classList.contains("sidebar-open")));
sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setSidebarOpen(false);
    setExplorerOpen(false);
  }
});
window.matchMedia?.("(max-width: 820px)").addEventListener("change", (event) => {
  if (!event.matches) setSidebarOpen(false);
});
themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem(STORAGE_THEME, next); } catch { /* Theme still applies for this page. */ }
});

filePreviewMode.addEventListener("click", () => {
  if (activeFilePreview?.language !== "markdown") return;
  markdownSourceMode = !markdownSourceMode;
  renderActiveFilePreview();
});
explorerToggle.addEventListener("click", () => setExplorerOpen(!explorerIsOpen()));
explorerClose.addEventListener("click", () => setExplorerOpen(false));
explorerBackdrop.addEventListener("click", () => setExplorerOpen(false));

applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");

loadMeta().catch((error) => showError(error.message));
