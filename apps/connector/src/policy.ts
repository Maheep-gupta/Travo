import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The policy cache is a few hundred bytes; anything far larger is not it. */
const MAX_POLICY_BYTES = 256 * 1024;

/**
 * Reads only `restrictions.allow_remote_control.allowed` from the Claude
 * Code managed policy cache. This is policy data, not session content or a
 * credential. Returns null when it cannot be determined (missing, unreadable,
 * oversized, not JSON, or the value isn't a boolean), which the domain layer
 * treats as "not allowed".
 */
export async function readRemoteControlPolicy(file = join(homedir(), ".claude", "policy-limits.json")): Promise<boolean | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_POLICY_BYTES) return null;
    const json = JSON.parse(await readFile(file, "utf8")) as {
      restrictions?: { allow_remote_control?: { allowed?: unknown } };
    } | null;
    const allowed = json?.restrictions?.allow_remote_control?.allowed;
    return typeof allowed === "boolean" ? allowed : null;
  } catch {
    return null;
  }
}
