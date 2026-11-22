import { describe, expect, it } from "vitest";

import { handleMemberPhoto, sanitizeProfilePhoto, withMemberPhotos } from "../src/profile-photo.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("profile photos on live maps", () => {
  it("keeps member data URLs and drops pdga.com picture links (PDGA data only through its developer API)", () => {
    expect(sanitizeProfilePhoto(PNG)).toBe(PNG);
    expect(sanitizeProfilePhoto("https://www.pdga.com/files/styles/square/player.jpg")).toBeNull();
    expect(sanitizeProfilePhoto("javascript:alert(1)")).toBeNull();
    expect(sanitizeProfilePhoto("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(sanitizeProfilePhoto("https://evil.example/photo.png")).toBeNull();
  });

  it("attaches roster photos onto start/join players", async () => {
    const kv = {
      async get(key: string) {
        if (key === "member:m_a") return JSON.stringify({ memberId: "m_a", name: "Alex", photo: PNG, pinHash: "x", mustChangePin: false });
        return null;
      },
      async put() {},
      async delete() {},
    };
    const players = await withMemberPhotos(kv, [
      { memberId: "m_a", name: "Alex" },
      { memberId: "g_guest", name: "Walk-on" },
    ]);
    expect(players[0]?.photo).toBe(PNG);
    expect(players[1]?.photo).toBeUndefined();
  });

  it("sets CORS and nosniff headers on 404 responses from handleMemberPhoto", async () => {
    const kv = {
      async get() { return null; },
      async put() {},
      async delete() {},
    };
    const badSig = await handleMemberPhoto("/member-photos/m_a/0000000000000000", { ROSTER: kv, JWT_SECRET: "x".repeat(40) });
    expect(badSig?.status).toBe(404);
    expect(badSig?.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(badSig?.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
