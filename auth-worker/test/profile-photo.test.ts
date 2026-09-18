import { describe, expect, it } from "vitest";

import { sanitizeProfilePhoto, withMemberPhotos } from "../src/profile-photo.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("profile photos on live maps", () => {
  it("keeps member data URLs and PDGA https photos", () => {
    expect(sanitizeProfilePhoto(PNG)).toBe(PNG);
    expect(sanitizeProfilePhoto("https://www.pdga.com/files/styles/square/player.jpg")).toMatch(/^https:\/\/www\.pdga\.com\//);
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
});
