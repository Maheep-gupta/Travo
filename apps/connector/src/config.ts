import { z } from "zod";
import { ConnectionConfig } from "@mc/api-client";

const Bool = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const Env = z.object({
  MC_SUPABASE_URL: ConnectionConfig.shape.url.optional(),
  MC_SUPABASE_PUBLISHABLE_KEY: ConnectionConfig.shape.publishableKey.optional(),
  MC_PROVIDER: z.enum(["mock", "claude-code"]).default("mock"),
  MC_POLL_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),
  MC_DATA_DIR: z.string().min(1).default(".data"),
  MC_SYNC_TRANSCRIPTS: Bool,
});

export type ConnectorConfig = z.infer<typeof Env>;

/**
 * The real Claude Code adapter stays disabled until the database isolation
 * (RLS) tests have run and passed against a real local Supabase.
 */
export const REAL_ADAPTER_ENABLED = false;

export function loadConfig(env: Record<string, string | undefined>): ConnectorConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid connector configuration:\n${issues}`);
  }
  if (parsed.data.MC_PROVIDER === "claude-code" && !REAL_ADAPTER_ENABLED) {
    throw new Error(
      "The claude-code provider is disabled in this build until the database isolation tests pass (see docs/FEASIBILITY.md). Use MC_PROVIDER=mock.",
    );
  }
  return parsed.data;
}
