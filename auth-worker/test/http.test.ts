import { describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import { allowedOrigin } from "../src/http.js";

const env = {
  ALLOWED_ORIGINS: "https://gvdgclub.com,https://www.gvdgclub.com",
} as Env;

function requestFrom(origin: string): Request {
  return new Request("https://auth.gvdgclub.com/events", { headers: { Origin: origin } });
}

describe("allowedOrigin", () => {
  it("allows exact configured production origins", () => {
    expect(allowedOrigin(env, requestFrom("https://gvdgclub.com"))).toBe("https://gvdgclub.com");
  });

  it("allows HTTPS Cloudflare Pages deployments for this project", () => {
    expect(allowedOrigin(env, requestFrom("https://ac8a7076.gvdg-club-site.pages.dev"))).toBe("https://ac8a7076.gvdg-club-site.pages.dev");
    expect(allowedOrigin(env, requestFrom("https://gvdg-club-site.pages.dev"))).toBe("https://gvdg-club-site.pages.dev");
  });

  it("rejects unrelated Pages projects and non-HTTPS project origins", () => {
    expect(allowedOrigin(env, requestFrom("https://other-project.pages.dev"))).toBeNull();
    expect(allowedOrigin(env, requestFrom("http://ac8a7076.gvdg-club-site.pages.dev"))).toBeNull();
  });
});
