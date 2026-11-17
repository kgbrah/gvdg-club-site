// Marketplace secrets at rest: keyed hashes for guest emails and one-time codes, and an AES-GCM copy of a
// guest's email so the club can relay mail to them without ever storing or showing the address in clear.
// Keys are derived from JWT_SECRET with a per-purpose label (HMAC), so no new secret is needed.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function unb64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, label: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(label + "\u0000" + value)));
}

/** Stable identity for a guest email (lower-cased, trimmed). */
export async function emailHash(secret: string, email: string): Promise<string> {
  return hex(await hmac(secret, "gvdg-market-email", email.trim().toLowerCase()));
}

/** A one-time code is bound to the email it was sent to. */
export async function codeHash(secret: string, emailHashValue: string, code: string): Promise<string> {
  return hex(await hmac(secret, "gvdg-market-code", emailHashValue + ":" + code));
}

async function emailKey(secret: string): Promise<CryptoKey> {
  const raw = await hmac(secret, "gvdg-market-email-key", "aes-gcm-256");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptEmail(secret: string, email: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await emailKey(secret), encoder.encode(email));
  return "v1." + b64(iv) + "." + b64(new Uint8Array(sealed));
}

export async function decryptEmail(secret: string, sealed: string): Promise<string | null> {
  try {
    const [version, iv, body] = sealed.split(".");
    if (version !== "v1" || !iv || !body) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) as BufferSource }, await emailKey(secret), unb64(body) as BufferSource);
    return decoder.decode(plain);
  } catch {
    return null;
  }
}

/** Uniform 6-digit code (rejection sampling avoids modulo bias). */
export function sixDigitCode(): string {
  const limit = 4_294_000_000; // largest multiple of 1e6 below 2^32
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n! < limit) return String(n! % 1_000_000).padStart(6, "0");
  }
}

/** Opaque public key for a trader (never derived from a member id or an email). */
export function newTraderKey(): string {
  return hex(crypto.getRandomValues(new Uint8Array(9)));
}

export function constantTimeEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
