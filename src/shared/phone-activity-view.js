import React from "react";

const h = React.createElement;

function failure(result) {
  switch (result?.data?.error) {
    case "invalid_activity_code": return "Check the code in the phone app. Codes expire in five minutes.";
    case "activity_pairing_not_approved": return "That code is no longer available, or four phones are already paired.";
    case "activity_round_unavailable": return "Open a live scorecard you can score before pairing a phone to it.";
    case "rate_limited": return "Too many attempts. Try again in a few minutes.";
    case "unauthorized": return "Sign in with your club member account.";
    default: return "Could not reach your activity archive. Check your connection and try again.";
  }
}

export function PhoneActivityPairing({ api, roundCode, eventId, showArchive = false }) {
  const roundKey = roundCode ? "round:" + roundCode : eventId ? "event:" + eventId : null;
  return h(ActivitySettings, { key: roundKey || "member", api, roundKey, showArchive });
}

function ActivitySettings({ api, roundKey, showArchive }) {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [devices, setDevices] = React.useState([]);
  const [tracks, setTracks] = React.useState([]);
  const [before, setBefore] = React.useState(null);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [removeTrack, setRemoveTrack] = React.useState(null);
  const [version, refresh] = React.useReducer((value) => value + 1, 0);

  React.useEffect(() => {
    if (!open) return undefined;
    let current = true;
    async function read() {
      try {
        const [devicePage, trackPage] = await Promise.all([
          api("/activity/pairings", { guest: false }),
          showArchive ? api("/activity/tracks", { guest: false }) : null,
        ]);
        if (!current) return;
        if (devicePage.ok) setDevices(devicePage.data.devices || []);
        else setMessage(failure(devicePage));
        if (trackPage?.ok) { setTracks(trackPage.data.tracks || []); setBefore(trackPage.data.before); }
        else if (trackPage) setMessage(failure(trackPage));
      } catch { if (current) setMessage(failure()); }
    }
    void read();
    return () => { current = false; };
  }, [open, api, showArchive, version]);

  async function action(work) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try { await work(); }
    catch { setMessage(failure()); }
    finally { setBusy(false); }
  }

  async function approve(event) {
    event.preventDefault();
    const result = await api("/activity/pairings/approve", { method: "POST", guest: false, body: { code, roundKey } });
    if (!result.ok) { setMessage(failure(result)); return; }
    setCode("");
    setMessage("Phone paired. Open the activity app to connect.");
    refresh();
  }

  async function revoke(deviceId) {
    const result = await api("/activity/pairings/" + deviceId, { method: "DELETE", guest: false });
    if (!result.ok) { setMessage(failure(result)); return; }
    setMessage("Phone access removed.");
    refresh();
  }

  async function download(track) {
    const result = await api("/activity/tracks/" + track.id + "?format=json", { guest: false });
    if (!result.ok) { setMessage(failure(result)); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "gvdg-activity.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function remove(track) {
    const result = await api("/activity/tracks/" + track.id, { method: "DELETE", guest: false });
    if (!result.ok) { setMessage(failure(result)); return; }
    setRemoveTrack(null);
    setMessage("Route removed from your club account.");
    refresh();
  }

  return h("details", { className: "watch-pairing", onToggle: (event) => setOpen(event.currentTarget.open) },
    h("summary", null, showArchive ? "Phone activity and private routes" : "Pair phone activity"),
    open && h("div", { className: "watch-pairing-body stack" },
      h("p", null, "Open your GVDG activity test app to get a code. Pairing lasts 30 days and can be removed here."),
      h("p", null, (roundKey ? "This app can read basket positions on this scorecard and upload routes to your account." : "This app can upload routes to your account.")
        + " Location is recorded after you start an activity. The app asks before uploading it."),
      h("form", { onSubmit: (event) => { event.preventDefault(); void action(() => approve(event)); } },
        h("label", { className: "lbl", htmlFor: id }, "Phone activity code"),
        h("input", { className: "field", id, value: code, autoComplete: "off", autoCapitalize: "characters", spellCheck: false,
          "aria-describedby": id + "-notice", maxLength: 12, required: true, onChange: (event) => setCode(event.target.value.toUpperCase()) }),
        h("button", { className: "btn", type: "submit", disabled: busy || code.replace(/[\s-]/g, "").length !== 8 }, "Pair phone")),
      h("p", { role: "status", id: id + "-notice" }, message),
      devices.length > 0 && h("ul", null, devices.map((device) => {
        const label = (device.platform === "ios" ? "iPhone" : "Android") + " paired " + new Date(device.approvedAt).toLocaleString();
        return h("li", { key: device.deviceId }, h("span", null, label),
          h("button", { className: "btn secondary", type: "button", disabled: busy, "aria-label": "Remove " + label,
            onClick: () => { void action(() => revoke(device.deviceId)); } }, "Remove phone"));
      })),
      showArchive && h("section", { className: "stack" },
        h("h3", null, "Uploaded routes"),
        !tracks.length && h("p", null, "No activity routes have been uploaded."),
        tracks.map((track) => {
          const label = new Date(track.startedAt).toLocaleString();
          return h("div", { key: track.id, className: "stack" },
            h("p", null, label + " · " + Math.round(track.distanceM) + " m recorded"),
            h("button", { className: "btn secondary", type: "button", "aria-label": "Download route recorded " + label,
              disabled: busy, onClick: () => { void action(() => download(track)); } }, "Download route"),
            removeTrack === track.id
              ? h(React.Fragment, null, h("p", null, "Remove this route from your club account?"),
                h("button", { className: "btn danger", type: "button", disabled: busy,
                  onClick: () => { void action(() => remove(track)); } }, "Confirm remove route"),
                h("button", { className: "btn secondary", type: "button", onClick: () => setRemoveTrack(null) }, "Keep route"))
              : h("button", { className: "btn secondary", type: "button", disabled: busy,
                onClick: () => setRemoveTrack(track.id) }, "Remove route"));
        }),
        before && h("button", { className: "btn secondary", type: "button", disabled: busy, onClick: () => {
          void action(async () => {
            const result = await api("/activity/tracks?before=" + before, { guest: false });
            if (result.ok) { setTracks((rows) => [...rows, ...result.data.tracks]); setBefore(result.data.before); }
            else setMessage(failure(result));
          });
        } }, "Load earlier routes"))));
}
