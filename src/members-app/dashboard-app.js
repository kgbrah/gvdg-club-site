import React from "react";

import { MemberDashboardShell } from "./dashboard-shell.js";
import { MemberOverviewDashboard } from "./overview-dashboard.js";
import { BagTagPanel } from "./bag-tag-panel.js";
import { LeagueSchedule, CompletedLeagueRounds } from "./club-leagues.js";
import { LazyGroup, lazyPanel, warmPanels } from "./lazy-panel.js";
import { useSessionToken } from "./session-token.js";
import { currentDashboardRoute } from "./dashboard-router.js";
import { RegistrationProvider } from "./registration-data.js";
import { usePracticeWorkspace } from "./practice-workspace.js";
import { PersonalPlayHistory } from "./play-stats-panel.js";

const h = React.createElement;

// Home, the shell and the nav ship in the entry bundle. Every other screen loads its code the first time
// it is opened (or in idle time after Home settles) and then stays mounted, as before.
const playPage = () => import("./play-page.js");
const registrationPanel = () => import("./registration-panel.js");
const morePage = () => import("./more-page.js");
const practicePanels = () => import("./practice-panels.js");
const MemberPlayPage = lazyPanel(playPage, "MemberPlayPage");
const UdiscHistory = lazyPanel(playPage, "UdiscHistory");
const MemberSeasonPage = lazyPanel(() => import("./season-page.js"), "MemberSeasonPage");
const MemberRegistrationPanel = lazyPanel(registrationPanel, "MemberRegistrationPanel");
const MemberCompletedEvents = lazyPanel(registrationPanel, "MemberCompletedEvents");
const MemberMorePage = lazyPanel(morePage, "MemberMorePage");
const MemberAccountPage = lazyPanel(morePage, "MemberAccountPage");
const MemberAppearancePage = lazyPanel(morePage, "MemberAppearancePage");
const MemberInstallPage = lazyPanel(morePage, "MemberInstallPage");
const MemberWalletPage = lazyPanel(morePage, "MemberWalletPage");
const MemberFieldTestPage = lazyPanel(() => import("./field-test-panel.js"), "MemberFieldTestPage");
const MemberBoardPanel = lazyPanel(() => import("./board-panel.js"), "MemberBoardPanel");
const MemberTeeSignsPanel = lazyPanel(() => import("./tee-signs-panel.js"), "MemberTeeSignsPanel");
const MemberClubPanel = lazyPanel(() => import("./club-panel.js"), "MemberClubPanel");
const MemberMessagesPanel = lazyPanel(() => import("./messages-panel.js"), "MemberMessagesPanel");
const MemberMarketplacePage = lazyPanel(() => import("./marketplace-panel.js"), "MemberMarketplacePage");
const MemberLostFoundPage = lazyPanel(() => import("./lost-found-panel.js"), "MemberLostFoundPage");
const ActiveStandingsPanel = lazyPanel(() => import("./active-standings-panel.js"), "ActiveStandingsPanel");
const DoublesLeaguePanel = lazyPanel(() => import("./doubles-league-panel.js"), "DoublesLeaguePanel");
const MemberCommunityPage = lazyPanel(() => import("./community-panel.js"), "MemberCommunityPage");
const MemberCourseDiscovery = lazyPanel(() => import("./community-courses-panel.js"), "MemberCourseDiscovery");
const MemberPracticePage = lazyPanel(practicePanels, "MemberPracticePage");
const MemberBagPage = lazyPanel(practicePanels, "MemberBagPage");

// The main tabs' code is fetched in idle time once Home has settled.
const WARM_PANELS = [MemberPlayPage, MemberSeasonPage, PersonalPlayHistory, MemberRegistrationPanel, MemberMorePage];
const RESULTS_PANELS = [MemberCompletedEvents, MemberSeasonPage];

function addVisited(visited, tab) {
  return visited.has(tab) ? visited : new Set(visited).add(tab);
}

export function MemberDashboardApp() {
  const token = useSessionToken();
  const [route, setRoute] = React.useState(currentDashboardRoute);
  // Tabs that have been opened stay mounted, so switching back keeps their state and data.
  const [visited, setVisited] = React.useState(() => new Set([currentDashboardRoute().tab]));
  const tab = route.tab;
  const practice = usePracticeWorkspace(token, tab === "practice" || tab === "my-bag");
  React.useEffect(() => {
    const update = () => {
      const next = currentDashboardRoute();
      setRoute(next);
      setVisited((current) => addVisited(current, next.tab));
    };
    window.addEventListener("gvdg:dashboard-tab-selected", update);
    update();
    return () => window.removeEventListener("gvdg:dashboard-tab-selected", update);
  }, []);
  React.useEffect(() => (token ? warmPanels(WARM_PANELS) : undefined), [token]);
  const opened = (key) => visited.has(key);
  return h(RegistrationProvider, null, [
    h("div", { id: "membersReactDashboardShell", key: "shell" }, h(MemberDashboardShell)),
    h("div", { className: "my-dashboard", id: "myDashboard", key: "overview" }, [
      h("div", { id: "membersReactOverviewPanel", key: "mount" }, h(MemberOverviewDashboard)),
    ]),
    h("div", { className: "player-play", id: "playerPlay", key: "play" }, [
      h("div", { id: "membersReactPlayPanel", key: "mount" }, opened("play") ? h(MemberPlayPage) : null),
    ]),
    h("div", { className: "my-dashboard", id: "mySeason", key: "season" }, [
      h("div", { id: "membersReactSeasonPanel", key: "mount" }, opened("season") ? h(MemberSeasonPage) : null),
    ]),
    h("div", { className: "club-register", id: "clubRegister", key: "registration" }, [
      h("div", { id: "membersReactRegistrationPanel", key: "mount" }, opened("events")
        ? h(MemberRegistrationPanel, { eventId: tab === "events" ? route.eventId : null })
        : null),
    ]),
    h("div", { className: "player-more", id: "playerMore", key: "more" }, [
      h("div", { id: "membersReactMorePanel", key: "mount" }, opened("more") ? h(MemberMorePage) : null),
    ]),
    h("div", { className: "club-board", id: "clubBoard", key: "board" }, [
      h("div", { id: "membersReactBoardPanel", key: "mount" }, opened("board") ? h(MemberBoardPanel) : null),
    ]),
    h("div", { className: "tee-capture", id: "teeCapture", key: "tee" }, [
      h("div", { id: "membersReactTeeSignsPanel", key: "mount" }, opened("tee")
        ? h(MemberTeeSignsPanel, { routeCourseId: tab === "tee" ? route.courseId : null })
        : null),
    ]),
    h("div", { id: "membersReactClubPanel", key: "club" }, opened("club") ? h(MemberClubPanel) : null),
    tab === "account" ? h(MemberAccountPage, { key: "account" }) : null,
    tab === "wallet" ? h(MemberWalletPage, { key: "wallet" }) : null,
    tab === "appearance" ? h(MemberAppearancePage, { key: "appearance" }) : null,
    tab === "install" ? h(MemberInstallPage, { key: "install" }) : null,
    tab === "field-test" ? h(MemberFieldTestPage, { key: "field-test" }) : null,
    tab === "tags" && token ? h(BagTagPanel, { key: "tags", token }) : null,
    tab === "messages" && token ? h(MemberMessagesPanel, { key: "messages", token }) : null,
    tab === "marketplace" && token ? h(MemberMarketplacePage, { key: "marketplace", token }) : null,
    tab === "lost-found" && token ? h(MemberLostFoundPage, { key: "lost-found", token }) : null,
    tab === "standings" ? h(ActiveStandingsPanel, { key: "standings", standalone: true }) : null,
    tab === "leagues" ? h(React.Fragment, { key: "leagues" }, [
      h(LeagueSchedule, { key: "current" }),
      h(DoublesLeaguePanel, { key: "doubles" }),
    ]) : null,
    tab === "results" ? h(LazyGroup, { panels: RESULTS_PANELS, key: "results" }, () => h("div", { className: "member-subpage member-results-page" }, [
      h(MemberCompletedEvents, { key: "completed" }),
      h(CompletedLeagueRounds, { key: "league-rounds" }),
      h(MemberSeasonPage, { key: "season", resultsOnly: true }),
    ])) : null,
    tab === "community" && token ? h(MemberCommunityPage, { token, key: "community" }) : null,
    tab === "course-discovery" && token ? h(MemberCourseDiscovery, { token, courseId: route.courseId, key: "course-discovery" }) : null,
    tab === "practice" && token ? h(MemberPracticePage, { workspace: practice, key: "practice" }) : null,
    tab === "my-bag" && token ? h(MemberBagPage, { workspace: practice, key: "my-bag" }) : null,
    tab === "imports" && token ? h(UdiscHistory, { key: "imports", token }) : null,
  ]);
}
