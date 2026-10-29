import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reads only `restrictions.allow_remote_control.allowed` from the Claude
 * Code managed policy cache. This is policy data, not session content or a
 * credential. Returns null when it cannot be determined, which the domain
 * layer treats as "not allowed".
 */
export async function readRemoteControlPolicy(file = join(homedir(), ".claude", "policy-limits.json")): Promise<boolean | null> {
  try {
    const json = JSON.parse(await readFile(file, "utf8")) as {
      restrictions?: { allow_remote_control?: { allowed?: unknown } };
    };
    const allowed = json.restrictions?.allow_remote_control?.allowed;
    return typeof allowed === "boolean" ? allowed : null;
  } catch {
    return null;
  }
}
