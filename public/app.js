const token = document.querySelector("#token");
const loadToken = document.querySelector("#load-token");
const workspace = document.querySelector("#workspace");
const thread = document.querySelector("#thread");
const threadRow = document.querySelector("#thread-row");
const timeout = document.querySelector("#timeout");
const prompt = document.querySelector("#prompt");
const formError = document.querySelector("#form-error");
const submit = document.querySelector("#submit");
const cancel = document.querySelector("#cancel");
const status = document.querySelector("#status");
const output = document.querySelector("#output");
const meta = document.querySelector("#meta");
const artifacts = document.querySelector("#artifacts");

let currentJobId;
let monitorController;

function showError(message) {
  formError.textContent = message;
  formError.classList.toggle("visible", Boolean(message));
}

function clearError() {
  showError("");
}

function authHeaders() {
  return {
    authorization: `Bearer ${token.value.trim()}`,
    "content-type": "application/json",
  };
}

function appendOutput(text) {
  if (!text) return;
  output.textContent += text;
  output.scrollTop = output.scrollHeight;
}

function setStatus(value) {
  status.textContent = value;
  status.style.color =
    value === "succeeded" ? "var(--ok)" :
    ["failed", "timed_out", "cancelled"].includes(value) ? "var(--bad)" :
    "var(--text)";
}

function addArtifact(name) {
  if (!currentJobId || artifacts.querySelector(`[data-name="${name}"]`)) return;
  const link = document.createElement("a");
  link.href = `/v1/jobs/${currentJobId}/artifacts/${encodeURIComponent(name)}`;
  link.dataset.name = name;
  link.textContent = name;
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    const response = await fetch(link.href, { headers: { authorization: `Bearer ${token.value.trim()}` } });
    if (!response.ok) return;
    appendOutput(`\n\n--- ${name} ---\n`);
    appendOutput(await response.text());
  });
  artifacts.append(link);
}

function handleEvent(data) {
  if (data.type === "started") setStatus("running");
  if (data.type === "stdout" || data.type === "stderr") appendOutput(data.text);
  if (data.type === "done") {
    setStatus(data.status);
    if (data.finalReport) appendOutput(`\n\n--- final.md ---\n${data.finalReport}`);
    for (const artifact of data.artifacts || []) addArtifact(artifact);
  }
}

function parseEventBlock(block) {
  let eventType = "message";
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventType = value;
    if (field === "data") dataLines.push(value);
  }
  if (eventType === "stream_error" || (dataLines.length > 0 && eventType !== "message")) {
    try {
      handleEvent(JSON.parse(dataLines.join("\n")));
    } catch {
      appendOutput(`\n[stream parse error] ${dataLines.join("\n")}\n`);
    }
  }
}

async function monitor(jobId) {
  monitorController?.abort();
  monitorController = new AbortController();
  const controller = monitorController;
  currentJobId = jobId;
  cancel.disabled = false;
  let lastSequence = 0;

  try {
    while (!controller.signal.aborted) {
      const response = await fetch(`/v1/jobs/${jobId}/events?after=${lastSequence}`, {
        headers: { authorization: `Bearer ${token.value.trim()}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const idLine = block.split(/\r?\n/).find((line) => line.startsWith("id:"));
          if (idLine) lastSequence = Math.max(lastSequence, Number(idLine.slice(3).trim()) || 0);
          parseEventBlock(block);
          if (block.includes("event: done")) finished = true;
        }
      }
      if (finished || controller.signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      setStatus("disconnected");
      appendOutput(`\n[stream disconnected] ${error.message}\n`);
    }
  } finally {
    if (monitorController === controller) cancel.disabled = true;
  }
}

async function loadMeta() {
  if (!token.value.trim()) return;
  const response = await fetch("/v1/meta", { headers: authHeaders() });
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("API Token 不正确，请从 data\\api-token.txt 载入完整内容");
    }
    throw new Error(`读取服务配置失败，HTTP ${response.status}`);
  }
  const data = await response.json();
  workspace.replaceChildren(
    ...data.allowedWorkspaces.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      return option;
    }),
  );
  meta.textContent = `runner=${data.runner} · timeout default=${data.defaultTimeoutSeconds}s`;
  threadRow.hidden = data.runner !== "cursor-desktop";
  if (threadRow.hidden) thread.value = "";
}

submit.addEventListener("click", async () => {
  clearError();
  const enteredToken = token.value.trim();
  if (enteredToken.length < 32) {
    showError("请先点击“载入本机 Token”，再提交任务。");
    token.focus();
    return;
  }
  if (!prompt.value.trim()) {
    showError("请输入任务指令。");
    prompt.focus();
    return;
  }
  submit.disabled = true;
  output.textContent = "";
  artifacts.replaceChildren();
  setStatus("submitting");
  try {
    const body = {
      workspace: workspace.value,
      prompt: prompt.value,
      timeoutSeconds: Number(timeout.value),
      idempotencyKey: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : (() => {
        const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      })(),
    };
    if (!threadRow.hidden && thread.value.trim()) body.thread = thread.value.trim();
    const response = await fetch("/v1/jobs", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    setStatus(data.job.status);
    monitor(data.job.id);
  } catch (error) {
    setStatus("error");
    showError(error.message);
    appendOutput(error.message);
  } finally {
    submit.disabled = false;
  }
});

cancel.addEventListener("click", async () => {
  if (!currentJobId) return;
  cancel.disabled = true;
  await fetch(`/v1/jobs/${currentJobId}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });
});

loadToken.addEventListener("click", async () => {
  loadToken.disabled = true;
  clearError();
  try {
    const response = await fetch("/local-token");
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.token) {
      throw new Error("无法读取本机 Token。请确认当前页面地址是本机 127.0.0.1，服务正在运行。");
    }
    if (!data.local) {
      throw new Error("远程页面不能读取本机 Token。请从本机打开 127.0.0.1 控制页。");
    }
    token.value = data.token;
    sessionStorage.setItem("bridge-token", token.value);
    await loadMeta();
    loadToken.textContent = "已载入";
  } catch (error) {
    showError(error.message);
  } finally {
    loadToken.disabled = false;
  }
});
token.addEventListener("input", () => {
  sessionStorage.setItem("bridge-token", token.value);
  clearError();
});
token.value = sessionStorage.getItem("bridge-token") || "";
if (token.value) {
  loadMeta()
    .then(() => { loadToken.textContent = "已载入"; })
    .catch((error) => showError(error.message));
}
