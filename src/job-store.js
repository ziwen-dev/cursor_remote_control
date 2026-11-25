import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export class JobStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.jobsDir = path.join(dataDir, "jobs");
    this.statePath = path.join(dataDir, "jobs-state.json");
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.jobsDir, { recursive: true });
    try {
      const stored = JSON.parse(await readFile(this.statePath, "utf8"));
      return Array.isArray(stored.jobs) ? stored.jobs : [];
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  jobDirectory(jobId) {
    return path.join(this.jobsDir, jobId);
  }

  eventsPath(jobId) {
    return path.join(this.jobDirectory(jobId), "events.ndjson");
  }

  requestPath(jobId) {
    return path.join(this.jobDirectory(jobId), "request.json");
  }

  async readRequest(jobId) {
    try {
      return JSON.parse(await readFile(this.requestPath(jobId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  async writeInitialJob(job, request) {
    const directory = this.jobDirectory(job.id);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(this.requestPath(job.id), JSON.stringify(request, null, 2), "utf8"),
      writeFile(this.eventsPath(job.id), "", "utf8"),
    ]);
  }

  persist(jobs) {
    const snapshot = JSON.stringify({ version: 2, jobs }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, snapshot, "utf8");
      await rename(temporaryPath, this.statePath);
    });
    return this.writeChain;
  }

  async removeJobDirectory(jobId) {
    await this.writeChain;
    await rm(this.jobDirectory(jobId), { recursive: true, force: true });
  }
}
