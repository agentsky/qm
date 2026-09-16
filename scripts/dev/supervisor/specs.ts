import type { ChildSpec, SlotPorts } from "../lib/types.ts";

export interface SpecInputs {
  worktree: string;
  ports: SlotPorts;
  baseEnv: Record<string, string>;
  watch: boolean;
  slack?: { botToken: string; appToken: string };
  sessionStore: string;
  runStore: string;
  databaseUrl: string;
  adminGrantsSeed: string;
  sandboxEnv: Record<string, string>;
}

export function buildChildSpecs(i: SpecInputs): ChildSpec[] {
  const watchArgs = i.watch ? ["--watch"] : [];
  const base = { ...i.baseEnv, ...i.sandboxEnv };
  const orgId = i.baseEnv.DEV_INSTANCE_ORG_ID || "acme";
  return [
    {
      name: "core",
      cwd: i.worktree,
      argv: ["node", "--env-file-if-exists=.env", ...watchArgs, "src/index.ts"],
      env: {
        ...base,
        ORG_ID: orgId,
        SESSION_STORE: i.sessionStore,
        RUN_STORE: i.runStore,
        PORT: String(i.ports.core),
        ...(i.databaseUrl ? { DATABASE_URL: i.databaseUrl } : {}),
        ...(i.adminGrantsSeed ? { ADMIN_GRANTS: i.adminGrantsSeed } : {}),
        PUBLIC_WEB_URL: `http://localhost:${i.ports.core}`,
        ...(i.slack
          ? {
              SLACK_BOT_TOKEN: i.slack.botToken,
              SLACK_APP_TOKEN: i.slack.appToken,
              DEV_INTROSPECTION: "1",
              DEV_HEALTH_PORT: String(i.ports.slackHealth),
            }
          : {}),
        CORE_ORG_ID: orgId,
        SHUTDOWN_DRAIN_MS: "2000",
      },
      port: i.ports.core,
      readiness: { kind: "log", pattern: `listening on :${i.ports.core}` },
      health: { kind: "tcp", port: i.ports.core },
      stopGraceMs: 15_000,
    },
  ];
}
