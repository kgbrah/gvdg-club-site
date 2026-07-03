export function deadlinePassed(raw: string | null | undefined, nowMs = Date.now()): boolean {
  const text = String(raw ?? "").trim();
  if (!text) return false;
  const time = Date.parse(text);
  return Number.isFinite(time) && time <= nowMs;
}
