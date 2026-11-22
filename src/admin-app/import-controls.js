import React from "react";

const h = React.createElement;

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function resultDetail(event) {
  return event.detail && typeof event.detail === "object" ? event.detail : {};
}

export function AdminImportControls() {
  const [csvText, setCsvText] = React.useState("");
  const [busyCsv, setBusyCsv] = React.useState(false);
  const csvRequest = React.useRef("");
  const [udiscUrl, setUdiscUrl] = React.useState("");
  const [busyUdisc, setBusyUdisc] = React.useState(false);
  const udiscRequest = React.useRef("");
  const requestCounter = React.useRef(0);

  React.useEffect(() => {
    function updateCsv(event) {
      const detail = resultDetail(event);
      if (!detail.requestId || detail.requestId !== csvRequest.current) return;
      setBusyCsv(false);
      csvRequest.current = "";
    }
    function updateUdisc(event) {
      const detail = resultDetail(event);
      if (!detail.requestId || detail.requestId !== udiscRequest.current) return;
      setBusyUdisc(false);
      udiscRequest.current = "";
    }
    window.addEventListener("gvdg:admin-csv-import-result", updateCsv);
    window.addEventListener("gvdg:admin-udisc-events-import-result", updateUdisc);
    return () => {
      window.removeEventListener("gvdg:admin-csv-import-result", updateCsv);
      window.removeEventListener("gvdg:admin-udisc-events-import-result", updateUdisc);
    };
  }, []);

  function requestCsvImport() {
    const requestId = `csv-import-${requestCounter.current += 1}`;
    const valid = Boolean(csvText.trim());
    csvRequest.current = requestId;
    setBusyCsv(true);
    dispatchRequest("gvdg:admin-csv-import-request", { csv: csvText, requestId, valid });
    if (!valid) setBusyCsv(false);
  }

  function requestUdiscImport() {
    const requestId = `udisc-events-import-${requestCounter.current += 1}`;
    const valid = /^https:\/\/(?:www\.)?udisc\.com\/(?:leagues|events)\//i.test(udiscUrl.trim());
    udiscRequest.current = requestId;
    setBusyUdisc(true);
    dispatchRequest("gvdg:admin-udisc-events-import-request", { requestId, url: udiscUrl.trim(), valid });
    if (!valid) setBusyUdisc(false);
  }

  return h("div", { className: "admin-surface admin-import-editor", "data-react-admin-import-controls": "ready" }, [
    h("p", { className: "dash-note", key: "note" }, [
      "Import candidates appear below; click ",
      h("em", { key: "em" }, "Create"),
      " to add an event.",
    ]),
    h("div", { className: "admin-import-csv", key: "csv" }, [
      h("label", { htmlFor: "csvImportText", key: "label" }, "Paste CSV (header: name,date,type,format)"),
      h("textarea", {
        id: "csvImportText",
        key: "textarea",
        onChange: (event) => setCsvText(event.target.value),
        placeholder: "name,date,type,format\nFall Open,2026-09-12,tournament,stroke",
        rows: 4,
        value: csvText,
      }),
      h("button", {
        className: "admin-btn secondary",
        disabled: busyCsv,
        id: "csvImportBtn",
        key: "button",
        onClick: requestCsvImport,
        type: "button",
      }, busyCsv ? "Previewing…" : "Preview CSV"),
    ]),
    h("div", { className: "admin-import-csv", key: "udisc" }, [
      h("label", { htmlFor: "udiscImportUrl", key: "label" }, "UDisc league or event link"),
      h("input", {
        id: "udiscImportUrl",
        key: "url",
        onChange: (event) => setUdiscUrl(event.target.value),
        placeholder: "https://udisc.com/leagues/your-league",
        type: "url",
        value: udiscUrl,
      }),
      h("button", {
        className: "admin-btn secondary",
        disabled: busyUdisc,
        id: "udiscImportBtn",
        key: "button",
        onClick: requestUdiscImport,
        type: "button",
      }, busyUdisc ? "Importing…" : "Import from UDisc"),
      h("p", { className: "dash-note", key: "hint" }, "A league link also loads past scores and the current season standings. Save those onto the league page from the list below."),
    ]),
  ]);
}
