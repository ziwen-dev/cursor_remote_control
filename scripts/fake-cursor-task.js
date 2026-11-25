import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const promptFile = process.env.BRIDGE_PROMPT_FILE;
const outputDir = process.env.BRIDGE_OUTPUT_DIR;
const jobId = process.env.BRIDGE_JOB_ID ?? "unknown";

if (!promptFile || !outputDir) {
  console.error("BRIDGE_PROMPT_FILE and BRIDGE_OUTPUT_DIR are required");
  process.exit(2);
}

const prompt = await readFile(promptFile, "utf8");
await mkdir(outputDir, { recursive: true });
console.log(`fake runner started for ${jobId}`);
await new Promise((resolve) => setTimeout(resolve, 150));
console.log(`received ${Buffer.byteLength(prompt, "utf8")} prompt bytes`);
await new Promise((resolve) => setTimeout(resolve, 150));

const finalReport = [
  "# Cursor Remote Bridge local runner result",
  "",
  `- Job: ${jobId}`,
  `- Prompt bytes: ${Buffer.byteLength(prompt, "utf8")}`,
  "- Runner: controlled local verification runner",
  "- Result: FAKE-CURSOR-OK",
  "",
].join("\n");

await writeFile(path.join(outputDir, "final.md"), finalReport, "utf8");
console.log("FAKE-CURSOR-OK");
