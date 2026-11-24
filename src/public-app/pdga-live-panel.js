import React from "react";

import { PdgaLivePanel as SharedPdgaLivePanel } from "../shared/pdga-live-panel.js";
import { publicApiBase } from "./public-api.js";

export {
  extractPdgaEventId,
  hasPdgaLiveDetailedStats,
  OnDemandPdgaLiveDrawer,
  pdgaLiveObText,
  pdgaLivePositionText,
  pdgaLiveStatPctText,
} from "../shared/pdga-live-panel.js";

const h = React.createElement;

export function PdgaLivePanel(props) {
  return h(SharedPdgaLivePanel, {
    ...props,
    apiBase: props?.apiBase || publicApiBase(),
  });
}
