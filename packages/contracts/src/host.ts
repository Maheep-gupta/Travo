import { z } from "zod";
import { PROVIDER_ERROR_KINDS } from "./constants.js";

const isoTimestamp = z.string().datetime({ offset: true });

/** Schema v4: why a host's session source is failing (see PROVIDER_ERROR_KINDS). */
export const ProviderErrorKind = z.enum(PROVIDER_ERROR_KINDS);
export type ProviderErrorKind = z.infer<typeof ProviderErrorKind>;

export const HostRow = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  platform: z.string().max(50).nullable(),
  connector_version: z.string().max(50).nullable(),
  remote_control_allowed: z.boolean().nullable(),
  last_seen_at: isoTimestamp.nullable(),
  /** Schema v2: when the host's session source (e.g. the Claude CLI) started failing; null while healthy. */
  provider_error_since: isoTimestamp.nullable(),
  /**
   * Schema v4: the failure's category while provider_error_since is set,
   * otherwise null. Also null for a failure reported by a pre-v4 connector.
   * A category this release doesn't know reads as null (the generic message),
   * so a newer one can't fail the whole host list. Optional so rows built by
   * older fixtures stay valid; absent means null.
   */
  provider_error_kind: ProviderErrorKind.nullable().optional().catch(null),
  paired_at: isoTimestamp.nullable(),
  revoked_at: isoTimestamp.nullable(),
  created_at: isoTimestamp,
});
export type HostRow = z.infer<typeof HostRow>;

export const HostName = z.string().trim().min(1).max(100);

/** Returned once to the owner when they start pairing a new host. */
export const PairingTicket = z.object({
  host_id: z.string().uuid(),
  code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  expires_at: isoTimestamp,
});
export type PairingTicket = z.infer<typeof PairingTicket>;

/** Request/response of the pair-host Edge Function. */
export const PairHostRequest = z.object({
  code: PairingTicket.shape.code,
  platform: z.string().max(50).optional(),
  connector_version: z.string().max(50).optional(),
});
export type PairHostRequest = z.infer<typeof PairHostRequest>;

export const PairHostResponse = z.object({
  host_id: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(32),
});
export type PairHostResponse = z.infer<typeof PairHostResponse>;

export const HeartbeatInput = z
  .object({
    platform: z.string().max(50),
    connector_version: z.string().max(50),
    remote_control_allowed: z.boolean().nullable(),
    /** Whether the last read of the session source succeeded (schema v2). */
    provider_ok: z.boolean(),
    /** Schema v4: why it didn't; null exactly when provider_ok is true. */
    provider_error_kind: ProviderErrorKind.nullable(),
  })
  // host_heartbeat refuses a category on a healthy source, and accepts none on
  // a failing one only for pre-v4 connectors: a v4 connector always names it.
  .refine((h) => h.provider_ok === (h.provider_error_kind === null), {
    message: "provider_error_kind must be null exactly when provider_ok is true",
    path: ["provider_error_kind"],
  });
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;
