import { z } from "zod";

const isoTimestamp = z.string().datetime({ offset: true });

export const HostRow = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  platform: z.string().max(50).nullable(),
  connector_version: z.string().max(50).nullable(),
  remote_control_allowed: z.boolean().nullable(),
  last_seen_at: isoTimestamp.nullable(),
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

export const HeartbeatInput = z.object({
  platform: z.string().max(50),
  connector_version: z.string().max(50),
  remote_control_allowed: z.boolean().nullable(),
});
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;
