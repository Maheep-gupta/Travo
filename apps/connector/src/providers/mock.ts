import { DemoSimulator, type DemoSimulatorOptions } from "@mc/demo";
import type { Provider, ProviderMessage, ProviderSession } from "../types.js";

/** Simulated sessions. Everything it reports is flagged as demo data. */
export class MockProvider implements Provider {
  readonly id = "mock" as const;
  readonly isDemo = true;
  private readonly sim: DemoSimulator;

  constructor(opts: DemoSimulatorOptions = {}) {
    this.sim = new DemoSimulator(opts);
  }

  async poll(): Promise<ProviderSession[]> {
    this.sim.tick();
    return this.sim.observe();
  }

  async messages(externalId: string): Promise<ProviderMessage[]> {
    return this.sim.messages(externalId);
  }
}
