import React from "react";

import { MemberBoardPanel } from "./board-panel.js";
import { MemberCommunityPage } from "./community-panel.js";
import { MemberCourseDiscovery } from "./community-courses-panel.js";
import { MemberClubPanel } from "./club-panel.js";
import { MemberDashboardShell } from "./dashboard-shell.js";
import { MemberAccountPage, MemberAppearancePage, MemberInstallPage, MemberMorePage, MemberWalletPage } from "./more-page.js";
import { MemberOverviewDashboard } from "./overview-dashboard.js";
import { ActiveStandingsPanel } from "./activity-panels.js";
import { BagTagPanel } from "./bag-tag-panel.js";
import { DoublesLeaguePanel } from "./doubles-league-panel.js";
import { ClubLeagueCards } from "./club-leagues.js";
import { useSessionToken } from "./session-token.js";
import { currentDashboardRoute } from "./dashboard-router.js";
import { MemberPlayPage, UdiscHistory } from "./play-page.js";
import { MemberRegistrationPanel, RegistrationProvider } from "./registration-panel.js";
import { MemberBagPage, MemberPracticePage } from "./practice-panels.js";
import { usePracticeWorkspace } from "./practice-workspace.js";
import { MemberSeasonPage } from "./season-page.js";
import { MemberTeeSignsPanel } from "./tee-signs-panel.js";

const h = React.createElement;

export function MemberDashboardApp() {
  const token = useSessionToken();
  const [route, setRoute] = React.useState(currentDashboardRoute);
  const tab = route.tab;
  const practice = usePracticeWorkspace(token, tab === "practice" || tab === "my-bag");
  React.useEffect(() => {
    const update = () => setRoute(currentDashboardRoute());
    window.addEventListener("gvdg:dashboard-tab-selected", update);
    setRoute(currentDashboardRoute());
    return () => window.removeEventListener("gvdg:dashboard-tab-selected", update);
  }, []);
  return h(RegistrationProvider, null, [
    h("div", { id: "membersReactDashboardShell", key: "shell" }, h(MemberDashboardShell)),
    h("div", { className: "my-dashboard", id: "myDashboard", key: "overview" }, [
      h("div", { id: "membersReactOverviewPanel", key: "mount" }, h(MemberOverviewDashboard)),
    ]),
    h("div", { className: "player-play", id: "playerPlay", key: "play" }, [
      h("div", { id: "membersReactPlayPanel", key: "mount" }, h(MemberPlayPage)),
    ]),
    h("div", { className: "my-dashboard", id: "mySeason", key: "season" }, [
      h("div", { id: "membersReactSeasonPanel", key: "mount" }, h(MemberSeasonPage)),
    ]),
    h("div", { className: "club-register", id: "clubRegister", key: "registration" }, [
      h("div", { id: "membersReactRegistrationPanel", key: "mount" }, h(MemberRegistrationPanel, { eventId: tab === "events" ? route.eventId : null })),
    ]),
    h("div", { className: "player-more", id: "playerMore", key: "more" }, [
      h("div", { id: "membersReactMorePanel", key: "mount" }, h(MemberMorePage)),
    ]),
    h("div", { className: "club-board", id: "clubBoard", key: "board" }, [
      h("div", { id: "membersReactBoardPanel", key: "mount" }, h(MemberBoardPanel)),
    ]),
    h("div", { className: "tee-capture", id: "teeCapture", key: "tee" }, [
      h("div", { id: "membersReactTeeSignsPanel", key: "mount" }, h(MemberTeeSignsPanel, { routeCourseId: tab === "tee" ? route.courseId : null })),
    ]),
    h("div", { id: "membersReactClubPanel", key: "club" }, h(MemberClubPanel)),
    tab === "account" ? h(MemberAccountPage, { key: "account" }) : null,
    tab === "wallet" ? h(MemberWalletPage, { key: "wallet" }) : null,
    tab === "appearance" ? h(MemberAppearancePage, { key: "appearance" }) : null,
    tab === "install" ? h(MemberInstallPage, { key: "install" }) : null,
    tab === "tags" && token ? h(BagTagPanel, { key: "tags", token }) : null,
    tab === "standings" ? h(ActiveStandingsPanel, { key: "standings" }) : null,
    tab === "leagues" ? h(React.Fragment, { key: "leagues" }, [
      h(ClubLeagueCards, { key: "current" }),
      h(DoublesLeaguePanel, { key: "doubles" }),
    ]) : null,
    tab === "results" ? h(MemberSeasonPage, { key: "results", resultsOnly: true }) : null,
    tab === "community" && token ? h(MemberCommunityPage, { token, key: "community" }) : null,
    tab === "course-discovery" && token ? h(MemberCourseDiscovery, { token, courseId: route.courseId, key: "course-discovery" }) : null,
    tab === "practice" && token ? h(MemberPracticePage, { workspace: practice, key: "practice" }) : null,
    tab === "my-bag" && token ? h(MemberBagPage, { workspace: practice, key: "my-bag" }) : null,
    tab === "imports" && token ? h(UdiscHistory, { key: "imports", token }) : null,
  ]);
}
