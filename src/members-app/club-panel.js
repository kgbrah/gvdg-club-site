import React from "react";

import { useClubDirectoryData } from "./club-data.js";
import { MemberDirectoryPanel } from "./club-directory-panel.js";
import { MeetingMinutesPanel } from "./meeting-minutes-panel.js";

const h = React.createElement;

export function MemberClubPanel() {
  const data = useClubDirectoryData();
  return h("div", {
    className: "members-react-club-panel",
    "data-react-club-panel": data ? "ready" : "loading",
  }, [
    h(MemberDirectoryPanel, { data, key: "directory" }),
    h(MeetingMinutesPanel, { key: "minutes" }),
  ]);
}
