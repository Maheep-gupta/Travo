#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Connector } from "./connector.js";
import { loadConfig } from "./config.js";
import { loadCredentials } from "./credentials.js";
import { pairHost } from "./pairing.js";
import { readRemoteControlPolicy } from "./policy.js";
import { MockProvider } from "./providers/mock.js";
import { MemoryTransport } from "./transports/memory.js";
import { SupabaseTransport } from "./transports/supabase.js";

const VERSION = "0.1.0";
const APP_DIR = resolve(import.meta.dirname, "..");

function log(line: string): void {
  console.log(`${new Date().toISOString()}  ${line}`);
}

function usage(): never {
  console.log(`Tavro connector ${VERSION}

Usage:
  npm run connector -- demo              Run the mock provider offline (no backend) with simulated outages
  npm run connector -- pair <CODE>       Pair this machine using a code from the web app
  npm run connector -- run               Sync to the configured Supabase project

Configuration: apps/connector/.env (see .env.example). No inbound ports are opened.`);
  process.exit(1);
}

async function main(): Promise<void> {
  const envFile = resolve(APP_DIR, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const [command, arg] = process.argv.slice(2);
  const config = loadConfig(process.env);
  const dataDir = resolve(APP_DIR, config.MC_DATA_DIR);

  if (command === "demo") {
    // Offline demonstration: no network at all. Toggles the transport to show
    // disconnect / reconnect handling.
    const transport = new MemoryTransport();
    const connector = new Connector({
      provider: new MockProvider(),
      transport,
      platform: process.platform,
      version: VERSION,
      remoteControlAllowed: null,
      syncTranscripts: false,
      pollMs: 2000,
      log,
    });
    log("demo: mock provider -> in-memory backend. All sessions are SIMULATED.");
    connector.start();
    let ticks = 0;
    setInterval(() => {
      ticks += 1;
      if (ticks % 10 === 5) {
        transport.available = false;
        log("demo: simulating network loss");
      }
      if (ticks % 10 === 8) {
        transport.available = true;
        log("demo: network restored");
      }
      const statuses = [...transport.sessions.values()].map((s) => `${s.external_id}=${s.status}`).join(" ");
      log(`demo: state=${connector.connectionState} events=${transport.events.length} heartbeats=${transport.heartbeats.length} ${statuses}`);
    }, 2000);
    return;
  }

  if (!config.MC_SUPABASE_URL || !config.MC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Set MC_SUPABASE_URL and MC_SUPABASE_PUBLISHABLE_KEY in apps/connector/.env");
  }

  if (command === "pair") {
    if (!arg) usage();
    const { hostId, file } = await pairHost({
      url: config.MC_SUPABASE_URL,
      publishableKey: config.MC_SUPABASE_PUBLISHABLE_KEY,
      code: arg,
      platform: process.platform,
      version: VERSION,
      dataDir,
    });
    log(`paired as host ${hostId}; credentials saved to ${file} (keep this file private)`);
    return;
  }

  if (command === "run") {
    const creds = await loadCredentials(dataDir);
    if (!creds) throw new Error("This machine is not paired yet. Run: npm run connector -- pair <CODE>");
    const remoteControlAllowed = await readRemoteControlPolicy();
    log(`provider=${config.MC_PROVIDER} remote_control_allowed=${String(remoteControlAllowed)} (remote commands are disabled in this release)`);
    const connector = new Connector({
      provider: new MockProvider(),
      transport: new SupabaseTransport(config.MC_SUPABASE_URL, config.MC_SUPABASE_PUBLISHABLE_KEY, creds),
      platform: process.platform,
      version: VERSION,
      remoteControlAllowed,
      syncTranscripts: config.MC_SYNC_TRANSCRIPTS,
      pollMs: config.MC_POLL_MS,
      log,
    });
    connector.start();
    const shutdown = () => {
      connector.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  usage();
}

main().catch((e: unknown) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
