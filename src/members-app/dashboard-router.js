import { NAME_KEY, PDGA_KEY, storageGet } from "./api.js";
import { readMemberContext } from "./member-context.js";

const DASH_TITLES = {
  overview: "Home",
  play: "Play",
  season: "Season",
  events: "Events",
  more: "More",
  board: "Member Board",
  tee: "Tee Sign Capture",
  club: "GVDG Member Directory",
};

const DASH_TABS = new Set(Object.keys(DASH_TITLES));
let selectedDashTab = "overview";
let routerInstalled = false;

function safeTab(tab) {
  return DASH_TABS.has(tab) ? tab : "overview";
}

function dashboardDetail(tab, extra = {}) {
  const context = readMemberContext(extra);
  return {
    ...context,
    tab,
    title: DASH_TITLES[tab] || DASH_TITLES.overview,
    name: context.name || storageGet(NAME_KEY) || null,
    pdgaNo: context.pdgaNo || storageGet(PDGA_KEY) || null,
    scroll: extra.scroll === true,
  };
}

function emitDashboardState(eventName, tab, extra = {}) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: dashboardDetail(tab, extra) }));
}

export function currentDashboardTab() {
  return selectedDashTab;
}

export function selectDashboardTab(tabValue, options = {}) {
  const tab = safeTab(tabValue);
  selectedDashTab = tab;
  emitDashboardState("gvdg:dashboard-tab-selected", tab, { scroll: options.scroll !== false });
}

function hashTab() {
  const hash = String(window.location.hash || "").replace(/^#/, "").split(/[/?]/)[0].toLowerCase();
  return DASH_TABS.has(hash) ? hash : null;
}

export function openMemberDashboard(detail = {}) {
  selectDashboardTab(hashTab() || "overview");
  emitDashboardState("gvdg:member-dashboard-ready", selectedDashTab, detail);
}

export function installDashboardRouter() {
  if (routerInstalled) return;
  routerInstalled = true;
  window.addEventListener("gvdg:select-dashboard-tab", (event) => selectDashboardTab(event.detail?.tab));
  window.addEventListener("gvdg:member-dashboard-opened", (event) => openMemberDashboard(event.detail || {}));
}
