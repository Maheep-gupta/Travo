import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PairHostResponse } from "@mc/contracts";
import { z } from "zod";

export const HostCredentials = PairHostResponse;
export type HostCredentials = z.infer<typeof HostCredentials>;

/**
 * Host credentials live in the connector's data directory (git-ignored).
 * On Windows the 0600 mode is advisory; the file is still inside the user's
 * profile/project folder. See docs/SECURITY.md.
 */
export function credentialsPath(dataDir: string): string {
  return join(dataDir, "host.json");
}

export async function saveCredentials(dataDir: string, creds: HostCredentials): Promise<string> {
  const file = credentialsPath(dataDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(HostCredentials.parse(creds), null, 2), { mode: 0o600 });
  return file;
}

export async function loadCredentials(dataDir: string): Promise<HostCredentials | null> {
  try {
    return HostCredentials.parse(JSON.parse(await readFile(credentialsPath(dataDir), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Host credentials file is corrupt; re-pair this host.", { cause: e });
  }
}
