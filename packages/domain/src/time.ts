/** Short relative time ("just now", "5m ago", "3h ago", "2d ago"). Platform-neutral. */
export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const s = Math.round((now.getTime() - t) / 1000);
  if (s < 0) return "just now";
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
