import { destination, readAppRoute, navigationHref } from "../shared/app-navigation.js";
import { readMemberContext } from "./member-context.js";

let selected = typeof window !== "undefined" ? readAppRoute("member", window.location) : { tab: "overview", eventId: null, courseId: null };
let routerInstalled = false;
let dashboardOpen = false;
let suppressPop = false;

export function suppressNextRouterPop() {
  suppressPop = true;
}

function dashboardDetail(route, extra = {}) {
  return { ...readMemberContext(extra), ...route, title: destination("member", route.tab).label, scroll: extra.scroll === true };
}

function emitDashboardState(eventName, route, extra = {}) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: dashboardDetail(route, extra) }));
}

export function currentDashboardTab() { return selected.tab; }

/** True while the app is in front and one of these screens is open: background polling waits otherwise (a screen
 *  stays mounted after you leave it, so its timers kept running on every other screen and in the background). */
export function dashboardShowing(...tabs) {
  return !(typeof document !== "undefined" && document.hidden) && (!dashboardOpen || tabs.includes(selected.tab));
}
export function currentDashboardRoute() { return selected; }

export function selectDashboardTab(tabValue, options = {}) {
  const route = {
    tab: destination("member", tabValue).key,
    eventId: options.eventId ?? null,
    courseId: options.courseId ?? (tabValue === "tee" ? selected.courseId : null),
  };
  if (options.history !== false) {
    const href = navigationHref("member", window.location, route.tab, route);
    const current = window.location.pathname + window.location.search + window.location.hash;
    if (href !== current) window.history.pushState(null, "", href);
  }
  selected = route;
  emitDashboardState("gvdg:dashboard-tab-selected", route, { scroll: options.scroll !== false });
}

function syncDashboardLocation(scroll = true) {
  const route = readAppRoute("member", window.location);
  if (scroll && route.tab === selected.tab && route.eventId === selected.eventId && route.courseId === selected.courseId) return;
  selectDashboardTab(route.tab, { ...route, history: false, scroll });
}

export function openMemberDashboard(detail = {}) {
  dashboardOpen = true;
  syncDashboardLocation(false);
  emitDashboardState("gvdg:member-dashboard-ready", selected, detail);
}

export function installDashboardRouter() {
  if (routerInstalled) return;
  routerInstalled = true;
  window.addEventListener("gvdg:select-dashboard-tab", (event) => {
    if (dashboardOpen) selectDashboardTab(event.detail?.tab, event.detail || {});
  });
  window.addEventListener("gvdg:member-dashboard-opened", (event) => openMemberDashboard(event.detail || {}));
  window.addEventListener("gvdg:member-shell-view", (event) => {
    if (event.detail?.view !== "members") dashboardOpen = false;
  });
  const followUrl = (event) => {
    if (event?.type === "popstate" && suppressPop) {
      suppressPop = false;
      return;
    }
    if (dashboardOpen) syncDashboardLocation();
  };
  window.addEventListener("popstate", followUrl);
  window.addEventListener("hashchange", followUrl);
}
