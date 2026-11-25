// v11: canonical per-route cache keys (/courses, /courses/:id/layouts, /courses/:id/positions)
// so routes never collide in edge cache while busting by courseId clears affected entries.
export const COURSE_CATALOG_CACHE_VERSION = "course-catalog-v11";
export const COURSE_CATALOG_CACHE_NAME = "gvdg-course-catalog";
export const COURSE_CATALOG_CACHE_ORIGIN = "https://auth.gvdgclub.com";
export const COURSE_CATALOG_CACHE_URL = `${COURSE_CATALOG_CACHE_ORIGIN}/courses?__gvdg_cache=${COURSE_CATALOG_CACHE_VERSION}`;

export function canonicalCatalogPath(requestOrPath?: Request | string): string {
  if (!requestOrPath) return "/courses";
  let rawPath: string;
  if (typeof requestOrPath === "string") {
    rawPath =
      requestOrPath.startsWith("http://") || requestOrPath.startsWith("https://")
        ? new URL(requestOrPath).pathname
        : requestOrPath.split("?")[0] || "/";
  } else {
    rawPath = new URL(requestOrPath.url).pathname;
  }
  const stripped = rawPath.replace(/^\/api(?=\/|$)/, "") || "/";
  return stripped.replace(/\/+$/, "") || "/";
}

export function courseCatalogCacheKey(requestOrPath?: Request | string): Request {
  const url = new URL(canonicalCatalogPath(requestOrPath), COURSE_CATALOG_CACHE_ORIGIN);
  url.searchParams.set("__gvdg_cache", COURSE_CATALOG_CACHE_VERSION);
  return new Request(url.toString(), { method: "GET" });
}

export async function bustCourseCatalogCache(courseId?: number | null): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  let busted = false;
  if (typeof caches.open === "function") {
    const cache = await caches.open(COURSE_CATALOG_CACHE_NAME);
    if (cache && typeof cache.delete === "function") {
      const keys = [courseCatalogCacheKey("/courses")];
      if (typeof courseId === "number" && Number.isInteger(courseId) && courseId > 0) {
        keys.push(
          courseCatalogCacheKey(`/courses/${courseId}/layouts`),
          courseCatalogCacheKey(`/courses/${courseId}/positions`),
        );
      }
      const deleted = await Promise.all(keys.map((key) => cache.delete(key)));
      busted = deleted.some(Boolean) || busted;
    }
  }
  if (typeof caches.delete === "function") {
    busted = (await caches.delete(COURSE_CATALOG_CACHE_NAME)) || busted;
  }
  return busted;
}
