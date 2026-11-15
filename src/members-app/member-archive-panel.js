import React from "react";
import { Archive, Download, Upload } from "lucide-react";
import { request } from "./api.js";
import {
  MAX_BACKUP_FILE_BYTES, MEMBER_ARCHIVE_SCHEMA, archiveDownloads, parseBackupFile, restoreParts,
} from "./member-archive-model.js";

const h = React.createElement;
const ENDPOINT = "/me/archive";
const LABELS = {
  round: ["round", "rounds"], disc: ["disc", "discs"], throw: ["measured throw", "measured throws"],
  putting: ["putting session", "putting sessions"], clip: ["video reference", "video references"],
};
const SOURCES = { competitive: "Club result", casual: "Casual round", udisc: "UDisc import", offline: "Offline round" };

async function archiveRequest(path, opts) {
  const response = await request(ENDPOINT + path, opts);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error || "archive_unavailable");
    error.status = response.status;
    throw error;
  }
  return data;
}

function exportError(error) {
  return error.status === 401 ? "Sign in again to use your archive." : "Couldn’t finish the download. Try again.";
}

function restoreError(error, partial) {
  if (error.status === 401) return "Sign in again, then select this file to continue.";
  if (error.message === "wrong_owner") return "This backup belongs to a different account.";
  if (error.message === "archive_limit") return "Your restored library is full. Remove saved copies and retry.";
  if (error.status === 429) return "Wait a minute before trying again. Previously saved copies will be skipped.";
  if (error.status === 400 || error.status === 413) return "This backup contains an unsupported or oversized record.";
  return partial ? "The restore paused. Retry to finish. Previously saved copies will be skipped." : "Couldn’t check the file. Try again.";
}

function countText(counts) {
  return Object.entries(counts).filter(([, count]) => count > 0)
    .map(([kind, count]) => count + " " + LABELS[kind][count === 1 ? 0 : 1]).join(" · ");
}

function downloadFile(file) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(file.blob);
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

function ArchiveButton({ children, Icon, ...props }) {
  return h("button", { className: "personal-archive-button", type: "button", ...props },
    Icon ? h(Icon, { size: 16, "aria-hidden": true }) : null, children);
}

function RoundDetails({ data }) {
  const { round, clock } = data;
  const dates = [
    ["Original start", clock.sourcePlayedAt], ["Original finish", clock.sourceFinishedAt], ["Started", clock.startedAt], ["Finished", clock.finalizedAt],
    ["Recorded", clock.resultRecordedAt],
  ].filter(([, value]) => value);
  return h(React.Fragment, null,
    h("p", { className: "player-card-meta" }, [
      round.total === null ? null : "Total " + round.total,
      round.toPar === null ? null : (round.toPar > 0 ? "+" : "") + round.toPar + " to par",
      round.group === "unknown" ? null : round.group,
    ].filter(Boolean).join(" · ")),
    dates.length ? h("dl", { className: "personal-archive-metadata" }, dates.map(([label, value]) =>
      h(React.Fragment, { key: label }, h("dt", null, label), h("dd", null, value)))) : null,
    round.holes.length ? h("div", { className: "personal-archive-table", tabIndex: 0, "aria-label": "Imported scorecard", role: "region" },
      h("table", null,
        h("thead", null, h("tr", null, ["Hole", "Par", "Throws", "Points", "Distance", "Shot details"]
          .map((label) => h("th", { key: label, scope: "col" }, label)))),
        h("tbody", null, round.holes.map((hole) => h("tr", { key: hole.hole },
          h("th", { scope: "row" }, hole.hole), h("td", null, hole.par ?? "—"), h("td", null, hole.strokes ?? "—"),
          h("td", null, hole.points ?? "—"), h("td", null, hole.distanceFt === null ? "—" : hole.distanceFt + " ft"),
          h("td", null, hole.shotLedger ? hole.shotLedger.rows.length + " recorded" :
            hole.marks.length ? hole.marks.length + " marked" : "—"),
        ))))) : null,
  );
}

function EntryDetails({ entry }) {
  const { kind, data } = entry;
  if (kind === "round") return h(RoundDetails, { data });
  if (kind === "clip") return h("p", { className: "player-card-meta" },
    [data.scope + " " + data.scopeKey, data.playerIndex !== undefined ? "Player slot " + (data.playerIndex + 1) : null,
      data.moment, data.createdAt].filter(Boolean).join(" · "));
  const record = data.record;
  if (kind === "putting") return h("ul", { className: "personal-archive-stations" },
    record.stations.map((station) => h("li", { key: station.meters }, station.distance + " " + station.unit + " · " +
      station.makes + " of " + station.attempts + " made")));
  const detail = kind === "disc" ? [record.plastic, record.weightGrams === null ? null : record.weightGrams + " g",
    record.archived ? "Archived" : record.inBag ? "In bag" : null, record.notes]
    : [record.meters + " m", record.origin ? "Measured positions saved in backup" : null];
  return h("p", { className: "player-card-meta" }, detail.filter(Boolean).join(" · "));
}

function downloadEntry(entry) {
  const manifest = { schemaVersion: MEMBER_ARCHIVE_SCHEMA, memberId: entry.owner, exportedAt: new Date().toISOString() };
  downloadFile(archiveDownloads(manifest, [entry], "json")[0]);
}

function EntryRow({ row, remove }) {
  const { entry, importedAt } = row;
  const data = entry.data;
  const record = data.record || {};
  const kind = entry.kind;
  const title = kind === "round" ? (data.round.courseName || data.round.eventName || "Round")
    : kind === "disc" ? [record.brand, record.model].filter(Boolean).join(" ")
      : kind === "throw" ? record.distance + " " + record.unit + " " + record.shotType
        : kind === "putting" ? "Putting practice" : "Hole " + data.hole + (data.playerName ? " · " + data.playerName : "");
  const description = kind === "round" ? [SOURCES[data.round.source], data.round.playedDate, data.round.layoutName].filter(Boolean).join(" · ")
    : kind === "clip" ? "Video reference · " + data.createdAt.slice(0, 10)
      : [LABELS[kind][0], data.occurredOn].filter(Boolean).join(" · ");
  const [confirm, setConfirm] = React.useState(false);
  return h("li", { className: "personal-archive-entry" },
    h("details", null,
      h("summary", null, h("strong", null, title), h("span", { className: "player-card-meta" }, description)),
      h("p", { className: "player-card-meta" }, "Imported snapshot · restored " + importedAt.slice(0, 10)),
      h(EntryDetails, { entry }),
      confirm ? h("div", { className: "personal-archive-confirm" },
        h("p", { className: "player-card-meta" }, "Remove this private copy?"),
        h(ArchiveButton, { onClick: () => remove(row.id) }, "Remove copy"),
        h(ArchiveButton, { onClick: () => setConfirm(false) }, "Keep copy"),
      ) : h("div", { className: "personal-archive-actions" },
        h(ArchiveButton, { Icon: Download, onClick: () => downloadEntry(entry) }, "Download this copy"),
        h(ArchiveButton, { onClick: () => setConfirm(true) }, "Remove restored copy"),
      ),
    ),
  );
}

function RestoredLibrary({ token, revision }) {
  const [open, setOpen] = React.useState(false);
  const [rows, setRows] = React.useState([]);
  const [cursor, setCursor] = React.useState(null);
  const [status, setStatus] = React.useState("");
  const loadRef = React.useRef(null);
  React.useEffect(() => () => loadRef.current?.abort(), []);
  const load = React.useCallback(async (after = null) => {
    if (after && loadRef.current) return;
    loadRef.current?.abort();
    const controller = new AbortController();
    loadRef.current = controller;
    setStatus("Loading restored copies…");
    try {
      const data = await archiveRequest("/records" + (after ? "?cursor=" + encodeURIComponent(after) : ""), { token, signal: controller.signal });
      if (controller.signal.aborted) return;
      setRows((prior) => after ? [...prior, ...data.rows] : data.rows);
      setCursor(data.next);
      setStatus("");
    } catch {
      if (!controller.signal.aborted) setStatus("Couldn’t load restored copies. Try again.");
    } finally {
      if (loadRef.current === controller) loadRef.current = null;
    }
  }, [token]);

  React.useEffect(() => {
    if (open) void load();
  }, [load, open, revision]);

  async function remove(id) {
    try {
      await archiveRequest("/records/" + id, { token, method: "DELETE" });
      setRows((prior) => prior.filter((row) => row.id !== id));
      setStatus("Restored copy removed.");
    } catch { setStatus("Couldn’t remove this copy. Try again."); }
  }

  return h("details", { className: "personal-archive-library", onToggle: (event) => setOpen(event.currentTarget.open) },
    h("summary", null, "Restored copies"),
    !open ? null : h(React.Fragment, null,
      status ? h("p", { role: "status", className: "player-card-meta" }, status) : null,
      !status && !rows.length ? h("p", { className: "player-card-meta" }, "No restored copies yet.") : null,
      rows.length ? h("ul", { className: "personal-archive-entries" },
        rows.map((row) => h(EntryRow, { key: row.id, row, remove }))) : null,
      cursor ? h(ArchiveButton, { onClick: () => { void load(cursor); } }, "More restored copies") : null,
      status.includes("Try again") ? h(ArchiveButton, { onClick: () => { void load(); } }, "Reload restored copies") : null,
    ),
  );
}

function OwnedArchive({ token }) {
  const file = React.useRef(null);
  const job = React.useRef(null);
  const stop = React.useRef(false);
  const [busy, setBusy] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [backup, setBackup] = React.useState(null);
  const [downloads, setDownloads] = React.useState([]);
  const [revision, setRevision] = React.useState(0);
  const id = React.useId();

  React.useEffect(() => () => job.current?.abort(), []);

  async function exportData(format) {
    if (job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setBusy("download");
    setStatus("Preparing your archive…");
    setDownloads([]);
    let cursor = null;
    const seen = new Set();
    let manifest;
    const entries = [];
    try {
      do {
        const data = await archiveRequest(cursor ? "?cursor=" + encodeURIComponent(cursor) : "", { token, signal: controller.signal });
        if (controller.signal.aborted) return;
        const { schemaVersion, memberId, exportedAt, definitions } = data;
        manifest ??= { schemaVersion, memberId, exportedAt, definitions };
        if (schemaVersion !== MEMBER_ARCHIVE_SCHEMA || manifest.memberId !== memberId || !Array.isArray(data.entries)) throw new Error("invalid_export");
        entries.push(...data.entries);
        cursor = data.next;
        if (cursor && seen.has(cursor)) throw new Error("invalid_cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      const files = archiveDownloads(manifest, entries, format);
      if (controller.signal.aborted) return;
      if (files.length === 1) downloadFile(files[0]);
      else setDownloads(files);
      setStatus(files.length === 1 ? "Your download is ready." : "Download each part to keep your full archive.");
    } catch (error) {
      if (!controller.signal.aborted) setStatus(exportError(error));
    } finally {
      if (job.current === controller) { job.current = null; setBusy(""); }
    }
  }

  function cancel() {
    const running = job.current;
    job.current = null;
    running?.abort();
    setBusy("");
    setBackup(null);
    setStatus("Cancelled.");
    if (file.current) file.current.value = "";
  }

  async function select(event) {
    const picked = event.target.files?.[0];
    if (!picked || job.current) return;
    event.target.value = "";
    setBackup(null);
    if (picked.size > MAX_BACKUP_FILE_BYTES) {
      setStatus("Select a JSON backup under 32 MB. Exported parts can be restored one at a time.");
      return;
    }
    const controller = new AbortController();
    job.current = controller;
    setBusy("preview");
    setStatus("Checking the backup…");
    try {
      const parsed = parseBackupFile(JSON.parse(await picked.text()));
      if (controller.signal.aborted) return;
      const parts = restoreParts(parsed.entries);
      if (!parts.length) { setStatus("This backup has no records."); return; }
      for (const entries of parts) {
        await archiveRequest("/restore", { token, signal: controller.signal, method: "POST", body: {
          schemaVersion: MEMBER_ARCHIVE_SCHEMA, memberId: parsed.memberId, entries, mode: "preview",
        } });
      }
      if (!controller.signal.aborted) {
        setBackup({ memberId: parsed.memberId, parts, counts: parsed.counts });
        setStatus("");
      }
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error.status ? restoreError(error, false) : "Choose a valid GVDG JSON backup.");
    } finally {
      if (job.current === controller) { job.current = null; setBusy(""); }
    }
  }

  async function restore() {
    if (!backup || job.current) return;
    stop.current = false;
    const controller = new AbortController();
    job.current = controller;
    setBusy("restore");
    let saved = 0;
    let duplicates = 0;
    try {
      for (const [index, entries] of backup.parts.entries()) {
        if (stop.current || controller.signal.aborted) break;
        setStatus("Restoring part " + (index + 1) + " of " + backup.parts.length + "…");
        const result = await archiveRequest("/restore", { token, signal: controller.signal, method: "POST", body: {
          schemaVersion: MEMBER_ARCHIVE_SCHEMA, memberId: backup.memberId, entries, mode: "restore",
        } });
        saved += result.saved;
        duplicates += result.duplicates;
      }
      if (!controller.signal.aborted) {
        const detail = saved + " restored · " + duplicates + " already saved.";
        setStatus(stop.current ? "Restore stopped. " + detail + " You can resume this file." : detail);
        if (!stop.current) setBackup(null);
      }
    } catch (error) {
      if (!controller.signal.aborted) setStatus(restoreError(error, true));
    } finally {
      if (job.current === controller) {
        job.current = null;
        setBusy("");
        setRevision((value) => value + 1);
      }
    }
  }

  return h("section", { className: "personal-archive-panel", "aria-labelledby": id },
    h("h2", { id }, h(Archive, { size: 19, "aria-hidden": true }), "Personal archive"),
    h("p", { className: "player-card-meta" }, "Back up your synced rounds, bag, and practice. Video references keep their original access. Restored copies stay separate from results and ratings."),
    h("div", { className: "personal-archive-actions" },
      h(ArchiveButton, { Icon: Download, disabled: Boolean(busy), onClick: () => { void exportData("json"); } }, "Download backup"),
      h(ArchiveButton, { disabled: Boolean(busy), onClick: () => { void exportData("csv"); } }, "Download CSV"),
      h("input", { accept: ".json,application/json", ref: file, type: "file", hidden: true, onChange: (event) => { void select(event); } }),
      h(ArchiveButton, { Icon: Upload, disabled: Boolean(busy), onClick: () => file.current?.click() }, "Choose backup file"),
      busy && busy !== "restore" ? h(ArchiveButton, { onClick: cancel }, "Cancel") : null,
    ),
    downloads.length ? h("div", { className: "personal-archive-actions" },
      downloads.map((part, index) => h(ArchiveButton, { key: part.name, onClick: () => downloadFile(part) }, "Download part " + (index + 1))),
    ) : null,
    backup ? h("section", { className: "personal-archive-preview", "aria-label": "Backup preview" },
      h("h3", null, "Restore private copies"),
      h("p", { className: "player-card-meta" }, countText(backup.counts)),
      h("p", { className: "player-card-meta" }, "Video bytes and activity saved only on a device are outside this backup."),
      h("div", { className: "personal-archive-actions" },
        busy === "restore" ? h(ArchiveButton, { onClick: () => { stop.current = true; setStatus("Stopping after this part…"); } }, "Stop after this part")
          : h(React.Fragment, null,
            h(ArchiveButton, { "data-primary": true, onClick: () => { void restore(); } }, "Restore copies"),
            h(ArchiveButton, { onClick: cancel }, "Cancel restore"),
          ),
      ),
    ) : null,
    status ? h("p", { role: "status", className: "player-card-meta" }, status) : null,
    h(RestoredLibrary, { token, revision }),
  );
}

export function PersonalArchivePanel({ token }) {
  return token ? h(OwnedArchive, { key: token, token }) : null;
}
