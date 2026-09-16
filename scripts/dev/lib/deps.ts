import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./proc.ts";

async function npmInstall(dir: string, logLabel: string, log: (msg: string) => void): Promise<void> {
  log(`installing ${logLabel} deps (first run in this worktree, may take a minute)...`);
  const res = await run("npm", ["install"], { cwd: dir, timeoutMs: 600_000 });
  if (res.code !== 0) {
    throw new Error(
      `npm install failed in ${dir}: ${(res.stderr || res.stdout || "").split("\n").slice(-8).join("\n")}`,
    );
  }
}

export async function ensureDeps(worktree: string, log: (msg: string) => void): Promise<void> {
  if (!existsSync(join(worktree, "node_modules/emoji-datasource"))) await npmInstall(worktree, "core", log);
}
