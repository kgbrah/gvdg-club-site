export class ImportError extends Error {}

function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = declaredLength(res.headers);
  if (declared != null && declared > maxBytes) throw new ImportError("response_too_large");
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ImportError("response_too_large");
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) throw new ImportError("response_too_large");
    text += decoder.decode(next.value, { stream: true });
  }
  return text + decoder.decode();
}

export function isAllowedUrl(raw: string, bases: string[]): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host.includes(":")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return bases.some((b) => host === b || host.endsWith("." + b));
}

export async function safeFetch(
  url: string,
  allowHosts: string[],
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { maxBytes = 1_000_000, timeoutMs = 8000 } = opts;
  if (!isAllowedUrl(url, allowHosts)) throw new ImportError("url_not_allowed");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "manual",
      headers: { "User-Agent": "GVDG-club-bot" },
    });
    if (res.status >= 300 && res.status < 400) throw new ImportError("redirect_blocked");
    if (!res.ok) throw new ImportError(`fetch_failed_${res.status}`);
    return await readTextCapped(res, maxBytes);
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError("fetch_error");
  } finally {
    clearTimeout(timer);
  }
}
