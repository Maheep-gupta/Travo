import type { Capability, ProviderId } from "@mc/contracts";

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  /** Capabilities the adapter actually implements in this release. */
  supported: readonly Capability[];
  /** Plain-language note shown when control is not possible. */
  limitation: string;
  /** Where to continue the work in an official Claude surface. */
  continueIn: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  mock: {
    id: "mock",
    label: "Demo data",
    supported: ["discover", "get_details", "read_messages", "subscribe_events"],
    limitation: "Simulated sessions for testing the dashboard. Not real Claude activity.",
    continueIn: "Not applicable: demo sessions are not real.",
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code (local)",
    supported: ["discover", "get_details", "read_messages", "subscribe_events"],
    limitation:
      "Replying is disabled: there is no supported API for injecting messages into a running terminal or IDE session, and your organisation has disabled Remote Control.",
    continueIn: "Continue in the terminal or VS Code window where the session is running.",
  },
  "claude-desktop": {
    id: "claude-desktop",
    label: "Claude Desktop",
    supported: [],
    limitation: "No documented API to list or control Claude Desktop conversations.",
    continueIn: "Open Claude Desktop on your laptop.",
  },
  cowork: {
    id: "cowork",
    label: "Cowork",
    supported: [],
    limitation: "No documented API for Cowork tasks. Dispatch is not available on Team plans.",
    continueIn: "Open Claude Desktop on your laptop.",
  },
  "claude-web": {
    id: "claude-web",
    label: "Claude (browser)",
    supported: [],
    limitation: "No official API for reading or sending messages in claude.ai conversations.",
    continueIn: "Open https://claude.ai in your browser.",
  },
};

export interface ControlPolicy {
  /** From the host's Claude policy; null when it could not be read. */
  remoteControlAllowed: boolean | null;
  /** Feature flag for this release. */
  repliesEnabled: boolean;
}

const CONTROL_CAPABILITIES: ReadonlySet<Capability> = new Set(["send_message", "resume", "approve_requests"]);

/**
 * Effective capabilities after applying policy. Control capabilities require
 * both the feature flag and an explicit organisational allowance; an unknown
 * policy is treated as "not allowed".
 */
export function effectiveCapabilities(provider: ProviderId, policy: ControlPolicy): Capability[] {
  return PROVIDERS[provider].supported.filter((cap) => {
    if (!CONTROL_CAPABILITIES.has(cap)) return true;
    return policy.repliesEnabled && policy.remoteControlAllowed === true;
  });
}

export function hasCapability(caps: readonly Capability[], cap: Capability): boolean {
  return caps.includes(cap);
}
