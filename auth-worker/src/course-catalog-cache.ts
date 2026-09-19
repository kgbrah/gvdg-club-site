export const COURSE_CATALOG_CACHE_VERSION = "course-catalog-v5";
export const COURSE_CATALOG_CACHE_NAME = "gvdg-course-catalog";

export function courseCatalogCacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.set("__gvdg_cache", COURSE_CATALOG_CACHE_VERSION);
  return new Request(url.toString(), { method: "GET" });
}

export async function bustCourseCatalogCache(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  return caches.delete(COURSE_CATALOG_CACHE_NAME);
}
