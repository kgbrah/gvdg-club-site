// v10: canonical key + cache.delete(request) busting so Cloudflare Workers edge cache clears on catalog writes.
export const COURSE_CATALOG_CACHE_VERSION = "course-catalog-v10";
export const COURSE_CATALOG_CACHE_NAME = "gvdg-course-catalog";
export const COURSE_CATALOG_CACHE_URL = `https://auth.gvdgclub.com/courses?__gvdg_cache=${COURSE_CATALOG_CACHE_VERSION}`;

export function courseCatalogCacheKey(_request?: Request): Request {
  return new Request(COURSE_CATALOG_CACHE_URL, { method: "GET" });
}

export async function bustCourseCatalogCache(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  let busted = false;
  if (typeof caches.open === "function") {
    const cache = await caches.open(COURSE_CATALOG_CACHE_NAME);
    if (cache && typeof cache.delete === "function") {
      busted = (await cache.delete(courseCatalogCacheKey())) || busted;
    }
  }
  if (typeof caches.delete === "function") {
    busted = (await caches.delete(COURSE_CATALOG_CACHE_NAME)) || busted;
  }
  return busted;
}
