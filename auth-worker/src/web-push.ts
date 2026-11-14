// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) using Web Crypto only.
// The private key never leaves the Worker. Payload encryption uses a fresh
// ephemeral P-256 key per message, matching the "aes128gcm" record layout.

const text = new TextEncoder();
const RECORD_SIZE = 4096;

export interface PushCryptoKeys {
  publicKey: string;
  privateKey: Uint8Array;
}

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromB64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function asBuf(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", asBuf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: asBuf(salt), info: asBuf(info) },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** Encrypt `message` for one browser subscription. Header carries the ephemeral public key. */
export async function encryptWebPush(message: Uint8Array, clientPublicKey: Uint8Array, authSecret: Uint8Array): Promise<Uint8Array> {
  if (clientPublicKey.length !== 65 || clientPublicKey[0] !== 4) throw new Error("bad client public key");
  if (authSecret.length !== 16) throw new Error("bad auth secret");
  if (message.length > 3000) throw new Error("push payload too large");

  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const senderPub = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const receiver = await crypto.subtle.importKey(
    "raw",
    asBuf(clientPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: receiver },
    local.privateKey,
    256,
  ));
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(text.encode("WebPush: info\0"), clientPublicKey, senderPub),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", asBuf(cek), "AES-GCM", false, ["encrypt"]);
  const record = concat(message, Uint8Array.of(2));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: asBuf(nonce) }, aes, asBuf(record)));

  const header = new Uint8Array(21 + senderPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPub.length;
  header.set(senderPub, 21);
  return concat(header, cipher);
}

export async function vapidAuthorization(endpoint: string, keys: PushCryptoKeys): Promise<string> {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const header = b64url(text.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64url(text.encode(JSON.stringify({ aud, exp, sub: "mailto:greenvillediscgolf@gmail.com" })));
  const signingInput = `${header}.${payload}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    asBuf(keys.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    asBuf(text.encode(signingInput)),
  ));
  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`;
}

export async function loadVapidKeys(publicKey: string | undefined, privateKey: string | undefined): Promise<PushCryptoKeys | null> {
  const pub = (publicKey ?? "").trim();
  const priv = (privateKey ?? "").trim();
  if (!pub || !priv) return null;
  const publicRaw = fromB64url(pub);
  const privateRaw = fromB64url(priv);
  if (!publicRaw || publicRaw.length !== 65 || publicRaw[0] !== 4 || !privateRaw) return null;
  try {
    await crypto.subtle.importKey("pkcs8", asBuf(privateRaw), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    return null;
  }
  return { publicKey: pub, privateKey: privateRaw };
}
