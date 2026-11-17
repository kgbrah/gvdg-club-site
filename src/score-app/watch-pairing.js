import React, { useEffect, useId, useState } from "react";

import { formatClubDateTime } from "../shared/events-model.js";

const h = React.createElement;

function pairingError(result) {
  switch (result.data?.error) {
    case "invalid_watch_code": return "Check the code on your watch. Codes expire after five minutes.";
    case "watch_pairing_not_approved": return "This code has expired, has already been used, or your card has four paired watches. Open a new code on the watch, or remove a watch below.";
    case "unauthorized": return "Sign in to this scorecard on your phone first.";
    case "not_live":
    case "card_locked":
    case "not_on_card":
    case "invalid_score_targets": return "Open an active scorecard you can score before pairing.";
    case "rate_limited": return "Too many attempts. Try again in a few minutes.";
    default: return "Couldn’t reach watch pairing. Try again when you’re online.";
  }
}

export function WatchPairing({ api, roundCode, eventId }) {
  const round = roundCode ? { roundCode } : { eventId };
  const query = new URLSearchParams(round).toString();
  return h(PairingForm, { api, round, query, key: query });
}

function PairingForm({ api, round, query }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [devices, setDevices] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [revision, refresh] = useState(0);
  const inputId = useId();

  useEffect(() => {
    if (!open) return;
    let current = true;
    api("/watch/pairings?" + query, { guest: false }).then((result) => {
      if (!current) return;
      if (result.ok) setDevices(Array.isArray(result.data?.devices) ? result.data.devices : []);
      else setNotice(pairingError(result));
    }).catch(() => { if (current) setNotice(pairingError({})); });
    return () => { current = false; };
  }, [api, open, query, revision]);

  async function approve(event) {
    event.preventDefault();
    if (busy || code.replace(/[\s-]/g, "").length !== 8) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await api("/watch/pairings/approve", { method: "POST", body: { ...round, code }, guest: false });
      if (!result.ok) {
        setNotice(pairingError(result));
        return;
      }
      setCode("");
      setNotice("Watch paired. Open the scorecard on your watch.");
      refresh((previous) => previous + 1);
    } catch {
      setNotice(pairingError({}));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await api("/watch/pairings/" + encodeURIComponent(deviceId), { method: "DELETE", guest: false });
      if (!result.ok) {
        setNotice(pairingError(result));
        return;
      }
      setDevices((rows) => rows.filter((row) => row.deviceId !== deviceId));
      setNotice("Watch access removed.");
      refresh((previous) => previous + 1);
    } catch {
      setNotice(pairingError({}));
    } finally {
      setBusy(false);
    }
  }

  return h("details", { className: "watch-pairing", onToggle: (event) => setOpen(event.currentTarget.open) },
    h("summary", null, "Pair a watch · preview"),
    open && h("div", { className: "watch-pairing-body" },
      h("p", null, "Requires a GVDG watch test app. App-store releases are not available yet."),
      h("p", null, "Open GVDG on your watch. Enter the code shown on your own watch to let it score on this card as you."),
      h("form", { onSubmit: approve },
        h("label", { htmlFor: inputId, className: "lbl" }, "Watch code"),
        h("input", {
          id: inputId, value: code, autoComplete: "off", autoCapitalize: "characters", spellCheck: false,
          className: "field", "aria-describedby": `${inputId}-notice`,
          maxLength: 10, required: true, onChange: (event) => setCode(event.target.value.toUpperCase()),
        }),
        h("button", { type: "submit", className: "btn", disabled: busy || code.replace(/[\s-]/g, "").length !== 8 }, "Pair watch"),
      ),
      h("p", { role: "status", id: `${inputId}-notice` }, notice),
      devices.length > 0 && h("ul", null, devices.map((device, index) => {
        const paired = formatClubDateTime(device.approvedAt) || "";
        return h("li", { key: device.deviceId },
          h("span", null, "Paired " + paired),
          h("button", {
            type: "button", className: "btn", disabled: busy, onClick: () => revoke(device.deviceId),
            "aria-label": `Remove watch ${index + 1}, paired ${paired}`,
          }, "Remove watch"),
        );
      })),
    ),
  );
}
