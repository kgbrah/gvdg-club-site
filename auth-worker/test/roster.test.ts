import { describe, it, expect } from "vitest";
import { putMember, resolveMember, getMember, setPin, type Member } from "../src/roster.js";
import type { KVLike } from "../src/ratelimit.js";

function makeKV(): KVLike {
  const m = new Map<string, string>();
  return {
    get: async (k) => (m.has(k) ? m.get(k)! : null),
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

const SAMPLE: Member = {
  memberId: "m_abc123",
  name: "Jane Doe",
  pdgaNo: "12345",
  udisc: "JaneD",
  pinHash: "pbkdf2$sha256$120000$x$y",
  mustChangePin: true,
};

describe("roster KV", () => {
  it("resolves a member by PDGA number", async () => {
    const kv = makeKV();
    await putMember(kv, SAMPLE);
    const m = await resolveMember(kv, "12345");
    expect(m?.memberId).toBe("m_abc123");
    expect(m?.name).toBe("Jane Doe");
  });

  it("resolves a member by UDisc username, case-insensitively", async () => {
    const kv = makeKV();
    await putMember(kv, SAMPLE);
    expect((await resolveMember(kv, "janed"))?.memberId).toBe("m_abc123");
    expect((await resolveMember(kv, "  JANED "))?.memberId).toBe("m_abc123");
  });

  it("returns null for an unknown identifier", async () => {
    const kv = makeKV();
    await putMember(kv, SAMPLE);
    expect(await resolveMember(kv, "99999")).toBeNull();
    expect(await resolveMember(kv, "nobody")).toBeNull();
  });

  it("setPin updates the hash and clears mustChangePin", async () => {
    const kv = makeKV();
    await putMember(kv, SAMPLE);
    await setPin(kv, "m_abc123", "pbkdf2$sha256$120000$new$hash");
    const m = await getMember(kv, "m_abc123");
    expect(m?.pinHash).toBe("pbkdf2$sha256$120000$new$hash");
    expect(m?.mustChangePin).toBe(false);
  });
});
