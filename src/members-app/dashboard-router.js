import { NAME_KEY, PDGA_KEY, storageGet } from "./api.js";
import { readMemberContext } from "./member-context.js";

const DASH_TABS = {
  overview: ["#myDashboard", "#clubRegister"],
  events: ["#clubRegister"],
  board: ["#clubBoard"],
  tee: ["#teeCapture"],
  club: ["#membersReactClubPanel"],
};

const DASH_TITLES = {
  overview: "Player Dashboard",
  events: "Event Registration",
  board: "Member Board",
  tee: "Tee Sign Capture",
  club: "GVDG Member Directory",
};

const DASH_ALL_SELECTORS = [...new Set(Object.values(DASH_TABS).flat())];
let selectedDashTab = "overview";

function byId(id) {
  return document.getElementById(id);
}

function safeTab(tab) {
  return DASH_TABS[tab] ? tab : "overview";
}

function dashboardDetail(tab, extra = {}) {
  const context = readMemberContext(extra);
  return {
    ...context,
    tab,
    title: DASH_TITLES[tab] || DASH_TITLES.overview,
    name: context.name || storageGet(NAME_KEY) || null,
    pdgaNo: context.pdgaNo || storageGet(PDGA_KEY) || null,
  };
}

function emitDashboardState(eventName, tab, extra = {}) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: dashboardDetail(tab, extra) }));
}

export function selectDashboardTab(tabValue) {
  const tab = safeTab(tabValue);
  selectedDashTab = tab;
  DASH_ALL_SELECTORS.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => el.classList.add("dtab-off"));
  });
  DASH_TABS[tab].forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => el.classList.remove("dtab-off"));
  });
  emitDashboardState("gvdg:dashboard-tab-selected", tab);
  byId("membersReactDashboardShell")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

export function openMemberDashboard(detail = {}) {
  selectDashboardTab("overview");
  emitDashboardState("gvdg:member-dashboard-ready", selectedDashTab, detail);
}

export function installDashboardRouter() {
  if (window.GVDG_MEMBER_DASHBOARD_ROUTER_READY) return;
  window.GVDG_MEMBER_DASHBOARD_ROUTER_READY = true;
  window.addEventListener("gvdg:select-dashboard-tab", (event) => selectDashboardTab(event.detail?.tab));
  window.addEventListener("gvdg:member-dashboard-opened", (event) => openMemberDashboard(event.detail || {}));
}
