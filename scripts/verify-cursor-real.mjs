import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.BRIDGE_URL ?? "http://127.0.0.1:7419";
const workspace = process.env.VERIFY_WORKSPACE ?? projectRoot;
const token = (
  process.env.BRIDGE_API_TOKEN ??
  await readFile(path.join(projectRoot, "data", "api-token.txt"), "utf8")
).trim();
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
const prompt = [
  "只读验证任务：检查当前工作区的项目结构和关键配置文件。不要修改任何文件，不要运行有副作用的命令。",
  "请用中文返回：主要组成部分、技术栈、三项风险，并明确列出是否修改了文件。",
].join("\n");

const createResponse = await fetch(`${baseUrl}/v1/jobs`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    workspace,
    prompt,
    timeoutSeconds: 600,
    idempotencyKey: `real-cursor-${crypto.randomUUID()}`,
  }),
});
const created = await createResponse.json();
if (!createResponse.ok) {
  throw new Error(`job creation failed: ${JSON.stringify(created)}`);
}
const jobId = created.job.id;
console.log(`JOB_ID=${jobId}`);

const eventResponse = await fetch(`${baseUrl}/v1/jobs/${jobId}/events`, { headers });
if (!eventResponse.ok) {
  throw new Error(`event stream failed: HTTP ${eventResponse.status}`);
}
const reader = eventResponse.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let doneEvent;
while (!doneEvent) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let match;
  while ((match = /\r?\n\r?\n/.exec(buffer))) {
    const block = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const event = JSON.parse(dataLines.join("\n"));
    if (event.type === "stdout" || event.type === "stderr") process.stdout.write(event.text);
    if (event.type === "done") doneEvent = event;
  }
}

const jobResponse = await fetch(`${baseUrl}/v1/jobs/${jobId}`, { headers });
const { job } = await jobResponse.json();
console.log(`\nJOB_STATUS=${job.status}`);
console.log(`AGENT_ID=${job.metadata?.agentId ?? ""}`);
console.log(`RUN_ID=${job.metadata?.runId ?? ""}`);
console.log(`ARTIFACTS=${(job.artifacts ?? []).join(",")}`);
if (doneEvent?.finalReport) {
  console.log("\n--- final.md ---\n");
  process.stdout.write(doneEvent.finalReport);
}
if (job.status !== "succeeded") process.exitCode = 1;
