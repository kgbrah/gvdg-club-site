// Admin › Import › The club's Google Sheets: bring people and account tiers, store credit balances, membership dues
// and bag tag standings over from the sheets admins keep today. The sheets are canon. Anyone not in the app gets a
// held account that carries over when they set up their sign-in. Read the sheet (link or pasted cells), check the
// columns, review every change, then apply. Applying the same sheet again changes nothing.
import React from "react";

import { FIELD_LABELS, SHEET_KINDS, fieldsFor, guessColumns, parseTable, readRows, sheetCsvUrl } from "../shared/sheet-import.js";
import { adminJson } from "./admin-api.js";
import { adminConfirm } from "./admin-dialogs.js";

const h = React.createElement;
const BATCH = 25;
const ACTION_LABEL = { update: "Changes", new: "New held account", same: "Already matches", skip: "Skipped" };
const HOW = { pdga: "PDGA #", udisc: "UDisc name", name: "name" };
const ERRORS = {
  no_series: "There's no active bag tag series. Start one in Bag tags first.",
  duplicate_tag: "Two rows have the same tag number. Fix the sheet and check again.",
  duplicate_member: "The same person has two tags on the sheet. Fix the sheet and check again.",
  invalid_rows: "Some rows couldn't be read. Check the columns and try again.",
};

function currentYear() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date()));
}

function Field({ label, children, htmlFor }) {
  return h("div", { className: "admin-import-csv" }, [h("label", { htmlFor, key: "l" }, label), children]);
}

function ColumnPicker({ field, headers, mapping, onChange }) {
  const id = "sheet-col-" + field;
  return h(Field, { htmlFor: id, label: FIELD_LABELS[field] }, h("select", {
    id, key: "s", onChange: (event) => onChange({ ...mapping, [field]: Number(event.target.value) }), value: String(mapping[field] ?? -1),
  }, [h("option", { key: "none", value: "-1" }, "Not on this sheet"), ...headers.map((header, index) => h("option", { key: index, value: String(index) }, header || `Column ${index + 1}`))]));
}

function PlanRow({ row, choice, onChoose }) {
  const change = row.before || row.after ? [row.before || "—", "→", row.after].join(" ") : "";
  const matched = row.match ? `Matched ${row.match.name} by ${HOW[row.match.how]}${row.match.held ? " (held)" : ""}` : "";
  return h("li", { className: "al-section admin-market-report", "data-sheet-row": row.line, "data-sheet-action": row.action }, [
    h("h3", { className: "al-h", key: "t" }, [`Row ${row.line} · ${row.name}`]),
    h("p", { className: "al-note", key: "m" }, [ACTION_LABEL[row.action], matched, change].filter(Boolean).join(" · ")),
    row.notes.length ? h("p", { className: "dash-note", key: "n" }, row.notes.join(" ")) : null,
    row.action === "new" && row.suggestions.length ? h(Field, { htmlFor: "sheet-pick-" + row.line, key: "pick", label: "Who is this?" },
      h("select", { id: "sheet-pick-" + row.line, key: "s", onChange: (event) => onChoose(row.line, event.target.value), value: choice || "" }, [
        h("option", { key: "new", value: "" }, "Someone new: hold an account for them"),
        ...row.suggestions.map((member) => h("option", { key: member.memberId, value: member.memberId }, `${member.name} (already in the app)`)),
      ])) : null,
  ]);
}

export function AdminSheetImport() {
  const [kind, setKind] = React.useState("balances");
  const [link, setLink] = React.useState("");
  const [pasted, setPasted] = React.useState("");
  const [table, setTable] = React.useState(null);
  const [mapping, setMapping] = React.useState(null);
  const [defaultTier, setDefaultTier] = React.useState("member");
  const [duesYear, setDuesYear] = React.useState(currentYear);
  const [series, setSeries] = React.useState(null);
  const [plan, setPlan] = React.useState(null);
  const [choices, setChoices] = React.useState({});
  const [busy, setBusy] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [done, setDone] = React.useState("");

  const reset = (next = {}) => { setPlan(null); setChoices({}); setDone(""); setMessage(""); if (next.table !== undefined) { setTable(next.table); setMapping(next.mapping ?? null); } };
  const chooseKind = (value) => { setKind(value); reset(); if (table) setMapping(guessColumns(value, table[0])); };

  React.useEffect(() => {
    if (kind !== "tags" || series !== null) return;
    adminJson("/admin/bag-tags").then((data) => setSeries(data?.series ?? false)).catch(() => setSeries(false));
  }, [kind, series]);

  function loadTable(text) {
    const parsed = parseTable(text);
    if (parsed.length < 2) { setMessage("That sheet has no rows under its header."); return; }
    reset({ table: parsed, mapping: guessColumns(kind, parsed[0]) });
  }

  async function readLink() {
    const url = sheetCsvUrl(link);
    if (!url) { setMessage("That isn't a Google Sheets link."); return; }
    setBusy("read");
    setMessage("");
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      // A sheet that isn't shared answers with Google's sign-in page, not the cells.
      const type = String(response.headers.get("content-type") || "");
      if (!/csv|text\/plain/i.test(type)) throw new Error("not csv: " + type);
      loadTable(await response.text());
    } catch {
      setMessage("The sheet couldn't be read. Share it as \"Anyone with the link can view\" (or File › Share › Publish to web), or copy its cells and paste them below.");
    } finally {
      setBusy("");
    }
  }

  const rows = table && mapping ? readRows(kind, table, mapping, { duesYear }) : [];
  const unreadable = rows.filter((row) => row.error);
  const sendable = rows.filter((row) => !row.error).map(({ error: _e, ...row }) => row);
  const hasName = mapping && (mapping.name >= 0 || mapping.first >= 0 || mapping.last >= 0 || mapping.pdga >= 0 || mapping.udisc >= 0);
  const valueField = SHEET_KINDS[kind].value;
  const hasValue = !valueField || (mapping && mapping[valueField] >= 0);

  async function check() {
    setBusy("plan");
    setMessage("");
    try {
      setPlan(await adminJson("/admin/sheet-import/plan", { method: "POST", body: { kind, rows: sendable, defaultTier, seriesId: series?.id } }));
      setChoices({});
    } catch (error) {
      setMessage(error.status === 404 ? ERRORS.no_series : "The sheet couldn't be checked. Try again.");
    } finally {
      setBusy("");
    }
  }

  const changes = plan ? plan.rows.filter((row) => row.action === "update" || row.action === "new") : [];
  const releasesCount = kind === "tags" ? (plan?.releases?.length || 0) : 0;
  const totalApplyCount = changes.length + releasesCount;
  async function apply() {
    if (!totalApplyCount) return;
    const ok = await adminConfirm({
      title: changes.length
        ? `Apply ${changes.length} ${changes.length === 1 ? "change" : "changes"}?`
        : `Release ${releasesCount} ${releasesCount === 1 ? "bag tag" : "bag tags"}?`,
      message: kind === "tags"
        ? "The bag tag standings become exactly this sheet." + (releasesCount ? ` ${releasesCount} not on it give up their tag.` : "")
        : "The app is set to match this sheet. Anyone new gets a held account until they sign up.",
      confirmText: "Apply",
    });
    if (!ok) return;
    const byLine = new Map(sendable.map((row) => [row.line, row]));
    const payload = changes.map((row) => ({ ...byLine.get(row.line), memberId: choices[row.line] || row.match?.memberId || "" }));
    setBusy("apply");
    setMessage("");
    try {
      if (kind === "tags") {
        const all = plan.rows.filter((row) => row.action !== "skip").map((row) => ({ ...byLine.get(row.line), memberId: choices[row.line] || row.match?.memberId || "" }));
        await adminJson("/admin/sheet-import/apply", { method: "POST", body: { kind, rows: all, defaultTier, seriesId: series?.id } });
      } else {
        for (let i = 0; i < payload.length; i += BATCH) {
          setMessage(`Applying ${Math.min(i + BATCH, payload.length)} of ${payload.length}…`);
          await adminJson("/admin/sheet-import/apply", { method: "POST", body: { kind, rows: payload.slice(i, i + BATCH), defaultTier } });
        }
      }
      setDone(changes.length
        ? `Done: ${changes.length} ${changes.length === 1 ? "change" : "changes"} from the sheet applied.`
        : `Done: ${releasesCount} ${releasesCount === 1 ? "tag" : "tags"} released from the sheet.`);
      setPlan(null);
      setMessage("");
    } catch (error) {
      const code = error.code || "";
      setMessage(code === "duplicate_member" ? ERRORS.duplicate_member
        : code === "duplicate_tag" ? ERRORS.duplicate_tag
        : code === "too_many_new_members" ? "Too many new people for one bag tag import (25 max). Import People first, then Bag Tags."
        : error.status === 409 ? ERRORS.duplicate_tag
        : error.status === 404 ? ERRORS.no_series
        : "Not everything applied. Check the sheet again: anything already done shows as matching.");
    } finally {
      setBusy("");
    }
  }

  const counts = plan?.counts;
  return h("section", { className: "admin-surface admin-import-editor", "data-admin-sheet-import": plan ? "review" : table ? "columns" : "start" }, [
    h("h2", { className: "admin-pane-kicker", key: "title" }, "The club's Google Sheets"),
    h("p", { className: "dash-note", key: "intro" }, "Bring what you track in Google Sheets into the app. The sheet is the source of truth: the app is set to match it, and anyone on it who isn't in the app gets a held account that carries over when they sign up."),
    h("div", { className: "admin-seg admin-sheet-kinds", key: "kinds", role: "radiogroup", "aria-label": "What's on this sheet?" }, Object.entries(SHEET_KINDS).map(([value, info]) => h("button", {
      "aria-checked": String(kind === value), className: kind === value ? "on" : "", key: value, onClick: () => chooseKind(value), role: "radio", type: "button",
    }, info.label))),
    kind === "tags" && series === false ? h("p", { className: "dash-note", key: "noseries", role: "alert" }, ERRORS.no_series) : null,
    kind === "tags" && series ? h("p", { className: "dash-note", key: "series" }, `Sets the standings of ${series.name}.`) : null,
    h(Field, { htmlFor: "sheetLink", key: "link", label: "Sheet link" }, h("input", {
      id: "sheetLink", key: "i", onChange: (event) => setLink(event.target.value), placeholder: "https://docs.google.com/spreadsheets/d/…", type: "url", value: link,
    })),
    h("button", { className: "admin-btn secondary", disabled: busy !== "" || !link.trim(), key: "read", onClick: () => { void readLink(); }, type: "button" }, busy === "read" ? "Reading…" : "Read the sheet"),
    h(Field, { htmlFor: "sheetCells", key: "paste", label: "Or paste the cells (select the sheet, copy, paste here)" }, h("textarea", {
      id: "sheetCells", key: "t", onChange: (event) => setPasted(event.target.value), rows: 4, value: pasted,
    })),
    h("button", { className: "admin-btn secondary", disabled: busy !== "" || !pasted.trim(), key: "use", onClick: () => loadTable(pasted), type: "button" }, "Use these cells"),

    table && mapping ? h("div", { className: "al-section", "data-sheet-columns": "true", key: "columns" }, [
      h("h3", { className: "al-h", key: "h" }, `Columns · ${table.length - 1} rows`),
      ...fieldsFor(kind).map((field) => h(ColumnPicker, { field, headers: table[0], key: field, mapping, onChange: (next) => { setMapping(next); setPlan(null); } })),
      kind === "dues" ? h(Field, { htmlFor: "sheetDuesYear", key: "year", label: "A paid mark (Yes, Paid, ✓) means paid through" }, h("input", {
        id: "sheetDuesYear", inputMode: "numeric", key: "i", onChange: (event) => { setDuesYear(Number(event.target.value) || currentYear()); setPlan(null); }, type: "number", value: duesYear,
      })) : null,
      h(Field, { htmlFor: "sheetTier", key: "default-tier", label: "New accounts are" }, h("select", { id: "sheetTier", key: "s", onChange: (event) => { setDefaultTier(event.target.value); setPlan(null); }, value: defaultTier }, [
        h("option", { key: "m", value: "member" }, "Members"), h("option", { key: "g", value: "guest" }, "Guests"),
      ])),
      unreadable.length ? h("p", { className: "dash-note", key: "bad", role: "alert" }, `Not sent: ${unreadable.map((row) => `row ${row.line} ${row.error}`).join("; ")}.`) : null,
      !hasName ? h("p", { className: "dash-note", key: "noname", role: "alert" }, "Pick the column with each person's name (or PDGA # / UDisc name).") : null,
      !hasValue ? h("p", { className: "dash-note", key: "novalue", role: "alert" }, `Pick the ${FIELD_LABELS[valueField]} column.`) : null,
      h("button", {
        className: "admin-btn", disabled: busy !== "" || !hasName || !hasValue || !sendable.length || (kind === "tags" && !series), key: "check",
        onClick: () => { void check(); }, type: "button",
      }, busy === "plan" ? "Checking…" : "Check against the app"),
    ]) : null,

    plan ? h("div", { className: "al-section", "data-sheet-plan": "true", key: "plan" }, [
      h("h3", { className: "al-h", key: "h" }, "Review"),
      h("p", { className: "al-note", key: "counts" }, [
        `${counts.update} to change`, `${counts.new} new held ${counts.new === 1 ? "account" : "accounts"}`, `${counts.same} already match`, counts.skip ? `${counts.skip} skipped` : "",
      ].filter(Boolean).join(" · ")),
      plan.releases.length ? h("p", { className: "dash-note", key: "rel" }, "Not on the sheet, so they give up their tag: " + plan.releases.map((row) => `#${row.tag} ${row.name}`).join(", ") + ".") : null,
      h("ul", { className: "admin-community-list", key: "rows" }, plan.rows.filter((row) => row.action !== "same").map((row) => h(PlanRow, {
        choice: choices[row.line], key: row.line, onChoose: (line, memberId) => setChoices((current) => ({ ...current, [line]: memberId })), row,
      }))),
      h("button", { className: "admin-btn", disabled: busy !== "" || !totalApplyCount, key: "apply", onClick: () => { void apply(); }, type: "button" },
        busy === "apply" ? "Applying…" : changes.length
          ? `Apply ${changes.length} ${changes.length === 1 ? "change" : "changes"}`
          : releasesCount
            ? `Release ${releasesCount} ${releasesCount === 1 ? "tag" : "tags"}`
            : "Nothing to change"),
    ]) : null,
    message ? h("p", { className: "dash-note", key: "msg", role: "status" }, message) : null,
    done ? h("p", { className: "dash-note", "data-sheet-done": "true", key: "done", role: "status" }, done) : null,
  ]);
}
