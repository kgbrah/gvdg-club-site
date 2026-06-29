import { describe, it, expect } from "vitest";
import { generateReply, type ReplyProvider } from "../src/assistant.js";

const msgs = [{ role: "user" as const, content: "hi" }];
const ok = (name: string, text: string): ReplyProvider => ({ name, generate: async () => text });
const fail = (name: string): ReplyProvider => ({ name, generate: async () => { throw new Error(name + " down"); } });

describe("generateReply (OpenRouter-primary, Workers-AI-fallback chain)", () => {
  it("uses the first provider that returns text", async () => {
    const r = await generateReply([ok("openrouter", "hello"), ok("workers-ai", "nope")], msgs);
    expect(r).toEqual({ reply: "hello", provider: "openrouter" });
  });

  it("falls back to the next provider when the first throws", async () => {
    const r = await generateReply([fail("openrouter"), ok("workers-ai", "backup")], msgs);
    expect(r).toEqual({ reply: "backup", provider: "workers-ai" });
  });

  it("falls back when the first returns empty/whitespace", async () => {
    const r = await generateReply([ok("openrouter", "   "), ok("workers-ai", "real")], msgs);
    expect(r?.provider).toBe("workers-ai");
  });

  it("trims the winning reply", async () => {
    const r = await generateReply([ok("openrouter", "  hi there \n")], msgs);
    expect(r?.reply).toBe("hi there");
  });

  it("returns null when every provider fails", async () => {
    const r = await generateReply([fail("openrouter"), fail("workers-ai")], msgs);
    expect(r).toBeNull();
  });
});
