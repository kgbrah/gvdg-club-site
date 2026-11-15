import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const OWNER = "qa-member";
const STAFF = "qa-staff";
const profileKey = "349ec82d-9f05-45dd-9e50-bc43d6976163";
const publicDate = "2026-11-14 00:00:00";
const originalProfile = { key: null, audience: "private", displayName: "", bio: "", shareProgress: false, revision: 0 };
const progress = {
  totals: { club: 2, casual: 1 }, streak: 2, streakCapped: false, achieved: [1], next: 5,
  weekly: [{ startsOn: "2026-11-02", rounds: 2 }, { startsOn: "2026-11-09", rounds: 1 }],
};
const originalCourse = {
  id: 31, name: "Riverside", location: "Greenville", difficulty: "beginner",
  amenities: { restrooms: "no", drinkingWater: "unknown", practiceBasket: "yes", accessibleParking: "yes", stepFreeRoute: "unknown" },
  notes: "Accessible parking at the main entrance.", updatedAt: publicDate, revision: 1,
};
const imageDir = process.env.GVDG_COMMUNITY_SCREENSHOTS;
if (imageDir) await mkdir(imageDir, { recursive: true });

let profile, review, course, favorite, reports;
function reset() {
  profile = { ...originalProfile };
  review = null;
  course = originalCourse;
  favorite = false;
  reports = false;
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function courseResponse() {
  return { ...course, reviewCount: review?.state === "published" ? 1 : 0, averageRating: review?.state === "published" ? review.rating : null };
}

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const vite = await createServer({
  configFile: false, cacheDir: "/tmp/gvdg-community-browser-qa", server: { host: "127.0.0.1", hmr: false },
  optimizeDeps: { entries: ["src/members-app/main.js", "src/admin-app/main.js"] },
  plugins: [{ name: "community-fixture", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/gvdg-members.html" || url.pathname === "/admin.html") {
        const file = url.pathname.slice(1);
        const entry = file === "admin.html" ? "admin" : "members";
        const html = (await readFile(file, "utf8")).replace(/<link[^>]+https:[^>]+>/g, "")
          .replace('data-auth-base=""', 'data-auth-base="/community-fixture"')
          .replace(/src="(?:members|admin)-app\/[^"]+"/, 'src="/src/' + entry + '-app/main.js"');
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url, html));
        return;
      }
      if (!url.pathname.startsWith("/community-fixture/")) { next(); return; }
      const path = url.pathname.slice("/community-fixture".length);
      const owner = req.headers.authorization?.slice(7);
      function respond(data, status = 200) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
      if (path === "/me") {
        respond({ sub: owner, pdgaNo: "123", name: owner === STAFF ? "QA Staff" : "QA Member", isAdmin: owner === STAFF }); return;
      }
      if (path === "/me/community") {
        respond({ profile, progress, contacts: [], blocked: [] }); return;
      }
      if (path === "/me/community/profile" && req.method === "PUT") {
        profile = { ...await jsonBody(req), key: profileKey, revision: profile.revision + 1 };
        respond({ profile }); return;
      }
      if (path === "/community/profiles/" + profileKey) {
        if (profile.audience !== "public") { respond({ error: "not_found" }, 404); return; }
        respond({ profile: { ...profile, progress: profile.shareProgress ? { total: progress.totals.club + progress.totals.casual } : null } }); return;
      }
      if (path === "/community/directory") { respond({ profiles: [], more: false }); return; }
      if (path === "/community/courses") {
        const restrooms = url.searchParams.get("restrooms");
        respond({ courses: !restrooms || restrooms === course.amenities.restrooms ? [courseResponse()] : [], more: false }); return;
      }
      if (path === "/community/courses/31/reviews") {
        const published = review?.state === "published" ? [{ ...review, own: owner === OWNER, reported: reports }] : [];
        respond({ course: courseResponse(), mine: owner === OWNER ? review : null, reviews: published, more: false }); return;
      }
      if (path === "/me/community/courses/31/review" && req.method === "PUT") {
        review = { ...await jsonBody(req), id: 3, revision: (review?.revision || 0) + 1, state: "pending", updatedAt: publicDate, courseId: course.id, courseName: course.name };
        respond({ mine: review }); return;
      }
      if (path.endsWith("/report")) { reports = true; respond({ ok: true }); return; }
      if (path === "/me/course-favorites") { respond({ courseIds: favorite ? [31] : [] }); return; }
      if (path === "/me/course-favorites/31") { favorite = req.method === "PUT"; respond({ favorite }); return; }
      if (path === "/admin/community/reviews") {
        assert.equal(owner, STAFF);
        respond({ queue: review?.state === "pending" || reports ? [{ ...review, reportCount: Number(reports), reasons: reports ? "unsafe" : null }] : [], more: false }); return;
      }
      if (path === "/admin/community/reviews/3" && req.method === "PUT") {
        assert.equal(owner, STAFF);
        const { action } = await jsonBody(req);
        if (action === "approve") review = { ...review, state: "published", publishedAt: publicDate };
        else if (action === "hide") review = { ...review, state: "hidden", publishedAt: null };
        reports = false;
        respond({ ok: true }); return;
      }
      if (path === "/admin/community/courses/31" && req.method === "PUT") {
        assert.equal(owner, STAFF);
        course = { ...course, ...await jsonBody(req), revision: course.revision + 1 };
        respond({ course: courseResponse() }); return;
      }
      respond({});
    });
  } }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});

async function contextPage(viewport, token) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(25000);
  if (token) await page.addInitScript((value) => localStorage.setItem("gvdg_member_token", value), token);
  return { context, page, errors };
}

async function screenshot(page, name) {
  if (imageDir) await page.screenshot({ path: join(imageDir, name + ".png") });
}

async function exercise(viewport, formFactor) {
  reset();
  const member = await contextPage(viewport, OWNER);
  const anon = await contextPage(viewport);
  const staff = await contextPage(viewport, STAFF);
  try {
    await member.page.goto(origin + "/gvdg-members.html#community", { waitUntil: "commit" });
    await member.page.getByRole("heading", { name: "Edit community profile" }).waitFor({ timeout: 60000 });
    await member.page.getByLabel("Who can see your profile?").selectOption("public");
    await member.page.getByLabel("Display name").fill("Park Disc");
    await member.page.getByLabel("About me").fill("Putting before sundown.");
    await member.page.getByRole("button", { name: "Save profile settings" }).click();
    await member.page.getByRole("link", { name: "Open public profile" }).waitFor();
    assert.equal(profile.shareProgress, false);
    await screenshot(member.page, "community-" + formFactor);

    await anon.page.goto(origin + "/gvdg-members.html?profile=" + profileKey, { waitUntil: "commit" });
    await anon.page.getByRole("heading", { name: "Park Disc" }).waitFor({ timeout: 60000 });
    assert.equal(await anon.page.getByText("3 completed GVDG rounds").count(), 0);
    await member.page.getByLabel("Who can see your profile?").selectOption("private");
    await member.page.getByRole("button", { name: "Save profile settings" }).click();
    await member.page.getByText("Profile settings saved.").waitFor();
    await anon.page.reload({ waitUntil: "commit" });
    await anon.page.getByRole("heading", { name: "Profile unavailable" }).waitFor();

    await member.page.getByRole("navigation", { name: "Member app" }).getByRole("button", { name: "Play" }).click();
    await member.page.getByRole("button", { name: "Course discovery" }).click();
    await member.page.getByText("Amenities and accessibility", { exact: true }).click();
    await member.page.getByLabel("Restrooms").selectOption("no");
    await member.page.getByRole("button", { name: "Find courses" }).click();
    await member.page.getByRole("button", { name: "Course details for Riverside" }).click();
    const details = member.page.getByRole("region", { name: "Course amenities and access" });
    await details.getByText("Unavailable", { exact: true }).waitFor();
    assert.equal(await details.getByText("Unknown", { exact: true }).count(), 2);
    await member.page.getByRole("button", { name: "Save as favorite", exact: true }).click();
    await member.page.getByRole("button", { name: "Remove favorite" }).waitFor();
    await member.page.getByRole("button", { name: "Write a review" }).click();
    await member.page.getByLabel("Rating", { exact: true }).selectOption("4");
    await member.page.getByLabel("Course review", { exact: true }).fill("Beginner-friendly from the short tees.");
    await member.page.getByRole("button", { name: "Send for moderation" }).click();
    await member.page.getByText("Awaiting moderation", { exact: false }).waitFor();
    await member.page.getByRole("region", { name: "Published course reviews" }).getByText("No published reviews yet.").waitFor();
    await member.page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await screenshot(member.page, "course-amenities-" + formFactor);

    await staff.page.goto(origin + "/admin.html#tools", { waitUntil: "commit" });
    await staff.page.getByRole("button", { name: "Review queue", exact: true }).waitFor({ timeout: 60000 });
    await staff.page.getByRole("button", { name: "Review queue", exact: true }).click();
    await staff.page.getByRole("button", { name: "Publish review" }).waitFor();
    await screenshot(staff.page, "course-moderation-" + formFactor);
    await staff.page.getByRole("button", { name: "Publish review" }).click();
    await staff.page.getByText("Review published.").waitFor();
    await staff.page.getByText("Maintain course amenities", { exact: true }).click();
    await staff.page.getByLabel("Course name or town").fill("Riverside");
    await staff.page.getByRole("button", { name: "Find course", exact: true }).click();
    await staff.page.getByLabel("Course to edit").selectOption("31");
    const metadata = staff.page.getByRole("form", { name: "Course discovery metadata" });
    await metadata.getByLabel("Restrooms").selectOption("yes");
    await metadata.getByRole("button", { name: "Save course details" }).click();
    await metadata.getByText("Course details saved.").waitFor();
    assert.equal(course.amenities.restrooms, "yes");

    await member.page.reload({ waitUntil: "commit" });
    await member.page.getByRole("region", { name: "Published course reviews" }).getByText("Beginner-friendly from the short tees.").waitFor();
    assert.equal(await member.page.getByRole("button", { name: "Report review" }).count(), 0);
    assert.deepEqual([...member.errors, ...anon.errors, ...staff.errors], []);
  } finally { await Promise.all([member.context.close(), anon.context.close(), staff.context.close()]); }
}

try {
  await exercise({ width: 390, height: 844 }, "mobile");
  await exercise({ width: 1280, height: 900 }, "desktop");
  console.log("Community QA passed on phone and desktop: audience control and revocation, access filters, favorites, private review queue and publication.");
} finally {
  await browser.close();
  await vite.close();
}
