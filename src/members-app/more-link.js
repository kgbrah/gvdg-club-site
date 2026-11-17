import React from "react";

import { destination } from "../shared/app-navigation.js";
import { selectDashboardTab } from "./dashboard-shell.js";

const h = React.createElement;

export function MoreLink({ tab, label, className = "player-more-item" }) {
  return h("button", {
    type: "button",
    className,
    onClick: () => selectDashboardTab(tab),
  }, label || destination("member", tab).label);
}
