import React from "react";

import { adminConfirm } from "./admin-dialogs.js";

const h = React.createElement;

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function rosterMeta(parts) {
  return parts.filter(Boolean).join(" / ");
}

function PaidChip({ paid }) {
  return h("span", {
    className: paid ? "admin-roster-chip paid" : "admin-roster-chip unpaid",
  }, paid ? "Paid" : "Unpaid");
}

export function RegistrationRow({ registration }) {
  const [division, setDivision] = React.useState(registration.division);
  const [team, setTeam] = React.useState(registration.team);
  const [startingHole, setStartingHole] = React.useState(registration.startingHole);
  const [checkedIn, setCheckedIn] = React.useState(registration.checkedIn);
  const [paidEntry, setPaidEntry] = React.useState(registration.paidEntry);
  const [amountValue, setAmountValue] = React.useState("");

  React.useEffect(() => {
    setDivision(registration.division);
    setTeam(registration.team);
    setStartingHole(registration.startingHole);
    setCheckedIn(registration.checkedIn);
    setPaidEntry(registration.paidEntry);
    setAmountValue("");
  }, [registration.id, registration.division, registration.team, registration.startingHole, registration.checkedIn, registration.paidEntry]);

  function patchText(field, value, previous) {
    const next = value.trim();
    if (next === previous) return;
    dispatchRequest("gvdg:admin-registration-roster-patch-request", {
      patch: { [field]: next || null },
      registration: registration.source,
    });
  }

  function patchStartingHole() {
    const parsed = Number.parseInt(startingHole, 10);
    const next = Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
    const previous = registration.startingHole ? Number.parseInt(registration.startingHole, 10) : null;
    if (next === previous) return;
    dispatchRequest("gvdg:admin-registration-roster-patch-request", {
      patch: { starting_hole: next },
      registration: registration.source,
    });
  }

  function submitOnEnter(event) {
    if (event.key === "Enter") event.currentTarget.blur();
  }

  function patchFlag(field, value) {
    dispatchRequest("gvdg:admin-registration-roster-patch-request", {
      patch: { [field]: value },
      registration: registration.source,
    });
  }

  async function requestRemove() {
    const confirmed = await adminConfirm({
      title: "Remove player",
      message: registration.paidEntry
        ? `Remove ${registration.name} from this event? Their entry is marked paid; this does not refund automatically.`
        : `Remove ${registration.name} from this event?`,
      confirmText: "Remove",
      danger: true,
    });
    if (!confirmed) return;
    dispatchRequest("gvdg:admin-registration-remove-request", { registration: registration.source });
  }

  const holeLabel = startingHole ? `Hole ${startingHole}` : "";
  const meta = rosterMeta([holeLabel, division, team]) || "No hole or division yet";

  return h("article", { className: "admin-roster-card", "data-admin-registration-id": registration.id }, [
    h("div", { className: "admin-roster-face", key: "face" }, [
      h("div", { className: "admin-roster-identity", key: "id" }, [
        h("strong", { className: "lb-name", key: "name" }, registration.name),
        h("span", { className: "admin-roster-meta", key: "meta" }, meta),
      ]),
      h("div", { className: "admin-roster-actions", key: "actions" }, [
        h(PaidChip, { key: "paid", paid: paidEntry }),
        h("button", {
          "aria-label": checkedIn ? `${registration.name} is checked in` : `Check in ${registration.name}`,
          "aria-pressed": checkedIn ? "true" : "false",
          className: checkedIn ? "admin-btn admin-roster-checkin on" : "admin-btn admin-roster-checkin",
          key: "checkin",
          onClick: () => {
            const next = !checkedIn;
            setCheckedIn(next);
            patchFlag("checked_in", next);
          },
          type: "button",
        }, checkedIn ? "In" : "Check in"),
      ]),
    ]),
    h("details", { className: "admin-roster-details", key: "details" }, [
      h("summary", { key: "sum" }, "Details"),
      h("div", { className: "admin-roster-fields", key: "fields" }, [
        h("label", { key: "division" }, [
          "Division",
          h("input", {
            "aria-label": `Division for ${registration.name}`,
            maxLength: 40,
            onBlur: () => patchText("division", division, registration.division),
            onChange: (event) => setDivision(event.target.value),
            onKeyDown: submitOnEnter,
            placeholder: "division",
            type: "text",
            value: division,
          }),
        ]),
        h("label", { key: "team" }, [
          "Team",
          h("input", {
            "aria-label": `Team for ${registration.name}`,
            maxLength: 40,
            onBlur: () => patchText("team", team, registration.team),
            onChange: (event) => setTeam(event.target.value),
            onKeyDown: submitOnEnter,
            placeholder: "pair/team",
            type: "text",
            value: team,
          }),
        ]),
        h("label", { key: "starting-hole" }, [
          "Start hole",
          h("input", {
            "aria-label": `Starting hole for ${registration.name}`,
            min: "1",
            onBlur: patchStartingHole,
            onChange: (event) => setStartingHole(event.target.value),
            onKeyDown: submitOnEnter,
            type: "number",
            value: startingHole,
          }),
        ]),
        h("label", { className: "admin-roster-toggle", key: "paid-entry" }, [
          h("input", {
            "aria-label": `Paid entry for ${registration.name}`,
            checked: paidEntry,
            onChange: (event) => {
              setPaidEntry(event.target.checked);
              patchFlag("paid_entry", event.target.checked);
            },
            type: "checkbox",
          }),
          "Paid entry",
        ]),
        registration.memberId ? h("div", { className: "credit-award", key: "credit" }, [
          h("input", {
            "aria-label": `Store credit amount for ${registration.name}`,
            key: "amount",
            min: "0",
            onChange: (event) => setAmountValue(event.target.value),
            placeholder: "$",
            step: "0.01",
            type: "number",
            value: amountValue,
          }),
          h("button", {
            className: "admin-btn secondary",
            key: "award",
            onClick: () => dispatchRequest("gvdg:admin-registration-roster-credit-request", {
              amountValue,
              memberId: registration.memberId,
              memberName: registration.name,
            }),
            type: "button",
          }, "Award"),
        ]) : null,
        h("button", {
          className: "admin-btn danger admin-roster-remove",
          key: "remove",
          onClick: requestRemove,
          type: "button",
        }, "Remove"),
      ].filter(Boolean)),
    ]),
  ]);
}

export function ManualPlayerRow({ player }) {
  async function requestRemove() {
    const confirmed = await adminConfirm({
      title: "Remove manual player",
      message: `Remove ${player.name || "this player"}?`,
      confirmText: "Remove",
      danger: true,
    });
    if (!confirmed) return;
    dispatchRequest("gvdg:admin-registration-manual-remove-request", { player: player.source });
  }

  const meta = rosterMeta([player.division, player.team]) || "Walk-on";

  return h("article", { className: "admin-roster-card", "data-admin-registration-manual-id": player.id }, [
    h("div", { className: "admin-roster-face", key: "face" }, [
      h("div", { className: "admin-roster-identity", key: "id" }, [
        h("strong", { className: "lb-name", key: "name" }, player.name),
        h("span", { className: "admin-roster-meta", key: "meta" }, meta),
      ]),
      h("div", { className: "admin-roster-actions", key: "actions" }, [
        h("span", { className: "admin-roster-chip walk-on", key: "tag" }, "Walk-on"),
        h("button", {
          className: "admin-btn danger",
          key: "remove",
          onClick: requestRemove,
          type: "button",
        }, "Remove"),
      ]),
    ]),
  ]);
}
