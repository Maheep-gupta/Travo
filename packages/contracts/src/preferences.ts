import { z } from "zod";

export const NotificationPrefs = z.object({
  on_waiting_for_input: z.boolean(),
  on_approval_required: z.boolean(),
  on_completed: z.boolean(),
  on_failed: z.boolean(),
  on_host_disconnected: z.boolean(),
  on_host_reconnected: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;
