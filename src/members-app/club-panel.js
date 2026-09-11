import React from "react";

import { clubDirectoryData } from "./club-data.js";
import { MemberDirectoryPanel } from "./club-directory-panel.js";
import { CourseConditionsPanel } from "./course-conditions-panel.js";
import { DoublesLeaguePanel } from "./doubles-league-panel.js";
import { MeetingMinutesPanel } from "./meeting-minutes-panel.js";

const h = React.createElement;

export function MemberClubPanel() {
  const data = clubDirectoryData();
  return h("div", {
    className: "members-react-club-panel",
    "data-react-club-panel": "ready",
  }, [
    h(CourseConditionsPanel, { key: "conditions" }),
    h(MemberDirectoryPanel, { data, key: "directory" }),
    h(MeetingMinutesPanel, { key: "minutes" }),
    h(DoublesLeaguePanel, { key: "doubles" }),
  ]);
}
