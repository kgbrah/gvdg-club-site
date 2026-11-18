import React from "react";
import { createPortal } from "react-dom";
import { useAccessibleDialog } from "../shared/a11y.js";
import { parseShotRows } from "../shared/shot-ledger.js";
import { createLocalRound, MAX_OFFLINE_PLAYERS, OFFLINE_ID, offlineRoundOutcome, offlineTargets } from "../shared/offline-round.js";
import { coursePackStore } from "../shared/course-packs.js";
import { SCORE_AUTH_EVENT } from "../shared/player-theme-session.js";
import { ScorecardView } from "./scorecard-view.js";
import { coursePackDate, useCoursePacks } from "./saved-courses-view.js";
import { offlineRoundStore } from "./offline-round-store.js";
import { offlineScorecard } from "./offline-round-score.js";
import { nextHoleScore } from "./score-view-model.js";
import { offlineAccount, offlineRequest, openOfflineIdentity, extendOpenArchive, sameOfflineOwner, syncOfflineRound, uploadOfflineClip, offlineClipUrl } from "./offline-round-sync.js";
import { useClipRecovery } from "./throw-film.js";
import { fieldLog, fieldMark, fieldRedactNames, fieldSince, fieldTestOn, fieldTrackClip } from "../shared/field-test-gate.js";

const h = React.createElement;
const HUB = "score.html?offline=1";
const CLOSED_CLIP_UPLOAD = async () => null;
const CLIPS_EVENT = "gvdg:throw-clips";

export function offlineScoreRoute(search) {
  const params = new URLSearchParams(search);
  const value = params.get("offline");
  if (!value) return null;
  if (value === "1") {
    const archive = params.get("archive");
    return /^\d{1,15}$/.test(archive || "") ? { archive } : { packKey: params.get("pack") };
  }
  return OFFLINE_ID.test(value) ? { localId: value } : { invalid: true };
}

const hrefFor = (id) => "score.html?offline=" + id;
const signInFor = (id) => "score.html?returnToOffline=" + id;

function useConnection() {
  const [connection, setConnection] = React.useState(() => ({ account: offlineAccount(), online: navigator.onLine }));
  React.useEffect(() => {
    function refresh() { setConnection({ account: offlineAccount(), online: navigator.onLine }); }
    const visibility = () => { if (!document.hidden) refresh(); };
    for (const event of ["online", "offline", "storage", "focus", SCORE_AUTH_EVENT]) window.addEventListener(event, refresh);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      for (const event of ["online", "offline", "storage", "focus", SCORE_AUTH_EVENT]) window.removeEventListener(event, refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const { account, online } = connection;
  React.useEffect(() => {
    if (!online || account?.kind !== "open" || !account.active || account.openArchive) return undefined;
    let current = true;
    void extendOpenArchive(account).then((actor) => {
      if (current && actor && sameOfflineOwner(actor, offlineAccount())) setConnection({ account: actor, online: navigator.onLine });
    });
    return () => { current = false; };
  }, [online, account?.kind, account?.active, account?.openArchive, account?.token]);
  return connection;
}

function storageNotice(error) {
  if (error?.code === "local_round_changed") return "This card changed in another tab. The latest saved card has been loaded.";
  if (error?.code === "offline_round_sealed") return "Upload already started. Retry the saved version to recover its receipt.";
  if (error?.code === "offline_owner_mismatch") return "Open this round with the account that owns it.";
  return error?.name === "QuotaExceededError"
    ? "Device storage is full. Free some space and make your edit again."
    : "This device could not confirm the save. Check storage and try again.";
}

function uploadNotice(round, account) {
  if (!round.owner) return "Saved on this device. Connect an account to upload a private copy.";
  if (round.receipt) return "Uploaded to your personal history.";
  if (!account?.active || ["unauthorized", "offline_owner_mismatch"].includes(round.uploadError)) return round.owner.kind === "open"
    ? "Saved on this device. Upload requires the open-play identity that owns this round."
    : "Saved on this device. Sign in with the account that owns this round, then retry.";
  if (round.uploadError === "offline_round_conflict") return "The server already has different data for this round ID. The device copy is intact.";
  if (round.uploadError && !round.retryAt) return "The archive rejected this upload. The device copy is intact. You can download it or retry.";
  if (round.retryAt) return "Saved on this device. Upload will retry when connected.";
  return "Saved on this device. Waiting to upload.";
}

function useArchiveSync(rounds, { account, online }, onRound, onError) {
  const candidates = rounds.filter((row) => row.finishedAt && !row.receipt && sameOfflineOwner(row.owner, account));
  const next = candidates.filter((row) => !row.uploadError || row.retryAt).sort((a, b) => (a.retryAt || 0) - (b.retryAt || 0))[0];
  const running = React.useRef(null);
  const [tick, wake] = React.useReducer((count) => count + 1, 0);
  const send = React.useCallback(async (row) => {
    if (running.current || !navigator.onLine) return;
    let actor = offlineAccount();
    if (sameOfflineOwner(actor, row.owner)) {
      running.current = row.localId;
      try {
        if (actor.active && actor.kind === "open" && !actor.openArchive) actor = await extendOpenArchive(actor) || actor;
        if (!sameOfflineOwner(offlineAccount(), actor)) return;
        const uploadMark = fieldMark();
        const result = await syncOfflineRound(offlineRoundStore, row, actor);
        if (uploadMark) {
          fieldLog("offline.upload", { roundId: row.localId, ms: fieldSince(uploadMark), ok: Boolean(result?.receipt),
            error: result?.uploadError || null, attempts: result?.attempts ?? null });
        }
        onRound(result);
        wake();
      } catch (error) { onError(storageNotice(error)); }
      finally { running.current = null; }
    }
  }, [onRound, onError]);
  React.useEffect(() => {
    if (!online || !next || !account?.active) return undefined;
    const timer = setTimeout(() => { void send(next); }, Math.max(0, (next.retryAt || 0) - Date.now()));
    return () => clearTimeout(timer);
  }, [next, online, account?.active, account?.token, send, tick]);
  return send;
}

function OfflineHeader({ title, back = HUB }) {
  return h(React.Fragment, null,
    h("a", { className: "btn ghost small", style: { textDecoration: "none" }, href: back }, back === "score.html" ? "Back to scoring" : "Offline rounds"),
    h("h2", { className: "section" }, title));
}

function OfflineSelect({ label, value, onChange, options }) {
  const id = React.useId();
  return h("div", { className: "course-range" },
    h("label", { className: "lbl", htmlFor: id }, label),
    h("select", { className: "field", id, value, onChange: (event) => onChange(event.target.value) },
      options.map(([key, text]) => h("option", { key, value: key }, text))));
}

function RosterSetup({ packs, preferredKey, account }) {
  const [key, setKey] = React.useState(preferredKey || "");
  const [groupFormat, setGroup] = React.useState("singles");
  const [scoringStyle, setStyle] = React.useState("stroke");
  const [names, setNames] = React.useState(() => [account?.name || ""]);
  const [deviceOnly, setDeviceOnly] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const pack = packs.find((row) => row.key === key) || packs[0];
  const step = groupFormat === "doubles" ? 2 : 1;
  const fixed = scoringStyle === "matchplay";
  const count = fixed ? step * 2 : Math.max(step, Math.ceil(names.length / step) * step);
  const roster = Array.from({ length: count }, (_, index) => names[index] || "");

  async function start(event) {
    event.preventDefault();
    if (busy || !pack) return;
    setBusy(true);
    setNotice("");
    try {
      const saved = await coursePackStore.get(pack.course.id, pack.layout.id);
      if (!saved.ok || saved.pack.contentRevision !== pack.contentRevision) {
        setNotice("The saved layout changed or could not be read. Reopen Offline rounds and choose a saved layout.");
        return;
      }
      const owner = deviceOnly ? null : account;
      if (owner && !sameOfflineOwner(owner, offlineAccount())) {
        setNotice("Your active account changed. Confirm the round owner and try again.");
        return;
      }
      const round = createLocalRound({ pack: saved.pack, owner, names: roster, format: { groupFormat, scoringStyle } });
      if (!round) { setNotice("Enter each player’s name and choose a layout with all pars."); return; }
      await offlineRoundStore.add(round);
      if (fieldTestOn()) {
        fieldRedactNames(roster);
        fieldLog("round.open", { mode: "offline", roundId: round.localId, courseId: pack.course.id ?? null, layoutId: pack.layout.id ?? null,
          holeCount: round.source.holes.length, playerCount: round.players.length, doubles: groupFormat === "doubles" });
      }
      location.assign(hrefFor(round.localId));
    } catch (error) { setNotice(storageNotice(error)); }
    finally { setBusy(false); }
  }

  if (!pack) return h("p", { className: "muted" }, "Save a scorable layout while connected to start a round offline.");
  return h("form", { className: "card stack", onSubmit: start },
    h("h3", { className: "section" }, "New offline round"),
    h(OfflineSelect, { label: "Saved layout", value: pack.key, onChange: setKey,
      options: packs.map((row) => [row.key, row.course.name + " · " + row.layout.name]) }),
    h("p", { className: "muted" }, pack.quality.holeCount + " holes · " + pack.assets.schematicHoles + " saved schematics. "
      + (pack.assets.schematicHoles < pack.quality.holeCount ? "Scoring works on holes without a map." : "Schematics are available offline.")),
    pack.quality.placeholderPars > 0 && h("p", { className: "muted" },
      "Estimated par on " + pack.quality.placeholderPars + (pack.quality.placeholderPars === 1 ? " hole." : " holes.")),
    h(OfflineSelect, { label: "Players", value: groupFormat, onChange: setGroup, options: [["singles", "Singles"], ["doubles", "Doubles"]] }),
    h(OfflineSelect, { label: "Scoring", value: scoringStyle, onChange: setStyle, options: [["stroke", "Stroke play"], ["matchplay", "Match play"]] }),
    groupFormat === "doubles" && h("p", { className: "muted" }, "Players are paired in order. Slots 1 and 2 are Team 1."),
    roster.map((name, index) => h("label", { className: "lbl", key: index }, index === 0 ? "Your name" : "Player " + (index + 1),
      h("input", { className: "field", value: name, required: true, maxLength: 60, autoComplete: "off",
        onChange: (event) => setNames(roster.map((entry, i) => i === index ? event.target.value : entry)) }))),
    !fixed && count < MAX_OFFLINE_PLAYERS && h("button", { className: "btn secondary", type: "button",
      onClick: () => setNames([...roster, ...Array(step).fill("")]) }, step === 1 ? "Add player" : "Add team"),
    !fixed && count > step && h("button", { className: "btn ghost", type: "button",
      onClick: () => setNames(roster.slice(0, count - step)) }, step === 1 ? "Remove last player" : "Remove last team"),
    account ? h("label", null,
      h("input", { type: "checkbox", checked: deviceOnly, onChange: (event) => setDeviceOnly(event.target.checked) }),
      " Keep this round unlinked on this device") : h("p", { className: "muted" }, "This round will stay on this device until you choose to link it."),
    account && !deviceOnly && h("p", { className: "muted" }, "Round owner: " + account.name),
    notice && h("p", { role: "alert" }, notice),
    h("button", { className: "btn", type: "submit", disabled: busy }, "Start offline round"));
}

function useRemoteRounds(connection, refreshKey) {
  const { account, online } = connection;
  const token = account?.token;
  const [page, setPage] = React.useState({ rows: [], before: null, token: null });
  const controller = React.useRef(null);
  const load = React.useCallback(async (before = null) => {
    if (!online || !token || !account.active) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const result = await offlineRequest("/offline-rounds" + (before ? "?before=" + before : ""), token, { signal: request.signal });
    if (request.signal.aborted || !sameOfflineOwner(account, offlineAccount())) return;
    if (result.ok && Array.isArray(result.data?.rounds)) setPage((previous) => ({ token, rows: [...(before && previous.token === token ? previous.rows : []), ...result.data.rounds],
      before: result.data.before }));
  }, [online, token, account?.active]);
  React.useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load, refreshKey]);
  return { ...page, rows: page.token === token ? page.rows : [], before: page.token === token ? page.before : null, load };
}

function OfflineHub({ route, connection }) {
  const { account } = connection;
  const { loading, packs, error } = useCoursePacks();
  const [notice, setNotice] = React.useState("");
  const [rounds, setRounds] = React.useState([]);
  const [revision, refresh] = React.useReducer((value) => value + 1, 0);
  const ownerKey = account ? account.kind + ":" + account.id : "device";
  const visible = rounds.filter((row) => !row.owner || sameOfflineOwner(account, row.owner));
  const remote = useRemoteRounds(connection, revision);
  const onRound = React.useCallback((row) => {
    setRounds((rows) => rows.map((item) => item.localId === row.localId ? row : item));
    if (row.receipt) refresh();
  }, []);
  useArchiveSync(visible, connection, onRound, setNotice);
  React.useEffect(() => {
    let current = true;
    offlineRoundStore.list(account).then((items) => { if (current) setRounds(items); },
      (failure) => { if (current) setNotice(storageNotice(failure)); });
    return () => { current = false; };
  }, [ownerKey, connection.online, revision]);
  const localReceipts = new Set(visible.map((row) => row.receipt?.id));
  const archived = remote.rows.filter((row) => !localReceipts.has(row.id));
  return h("div", { className: "stack" },
    h(OfflineHeader, { title: "Offline rounds", back: "score.html" }),
    notice && h("p", { role: "alert" }, notice),
    visible.length > 0 && h("section", { className: "card stack" },
      h("h3", { className: "section" }, "On this device"),
      visible.map((row) => h("div", { className: "stack", key: row.localId },
        h("a", { className: "btn secondary", style: { textDecoration: "none" }, href: hrefFor(row.localId) }, row.source.courseName + " · " + row.source.layoutName),
        h("p", { className: "muted" }, coursePackDate(row.startedAt) + " · " + (row.finishedAt ? uploadNotice(row, account) : "In progress"))))),
    loading ? h("p", { role: "status" }, "Reading saved course layouts…")
      : error ? h("p", { role: "alert" }, "Saved course layouts could not be read. Check device storage and try again.")
      : h(RosterSetup, { key: ownerKey, packs: packs.filter((row) => row.quality.scorable), preferredKey: route.packKey, account }),
    (archived.length > 0 || remote.before) && h("section", { className: "card stack" },
      h("h3", { className: "section" }, "Personal archive"),
      archived.map((row) => h("a", { className: "btn secondary", key: row.id,
        href: HUB + "&archive=" + row.id }, row.courseName + " · " + row.layoutName + " · " + coursePackDate(row.finishedAt))),
      remote.before && h("button", { className: "btn secondary", type: "button", onClick: () => { void remote.load(remote.before); } }, "Load earlier rounds")));
}

function exportLocal(round) {
  const { localId, owner, startedAs, source, format, players, scores, shots, marks, startedAt, finishedAt, receipt } = round;
  const data = JSON.stringify({ schemaVersion: "gvdg-local-round-1", localId, owner, startedAs, source, format, players,
    scores, shots, marks, startedAt, finishedAt, receipt }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "gvdg-offline-" + localId + ".json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RoundSummary({ round }) {
  const outcome = offlineRoundOutcome(round);
  const relative = (value) => value > 0 ? "+" + value : value === 0 ? "E" : String(value);
  const leader = outcome.summaries.find((row) => row.id === outcome.match?.leader);
  return h("section", { className: "card stack" },
    h("h3", { className: "section" }, round.source.courseName),
    h("p", { className: "muted" }, round.source.layoutName + " · " + coursePackDate(round.startedAt)),
    outcome.match && h("p", null, "Match: " + [leader?.label, outcome.match.label].filter(Boolean).join(" ")),
    outcome.summaries.map((row) => h("p", { key: row.id }, row.label + (row.type === "pair" ? " · " + row.members.join(" / ") : "")
      + " · " + row.total + " strokes (" + relative(row.toPar) + ") · " + row.thru + " holes")),
    h("details", null, h("summary", null, "Hole scores"),
      round.source.holes.map(({ hole, par }) => h("p", { key: hole }, "Hole " + hole + " (par " + par + ") · "
        + outcome.summaries.map((row) => row.label + " " + (round.scores[row.id]?.[hole] ?? "—")).join(" · ")))));
}

function ClipPreview({ caption, blob, path, token }) {
  const [source, setSource] = React.useState(null);
  const [error, setError] = React.useState("");
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    let objectUrl;
    async function load() {
      try {
        const data = blob || await offlineClipUrl(path, token, controller.signal);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(data);
        setSource(objectUrl);
      } catch {
        if (!controller.signal.aborted) setError("This clip could not be opened. Check your connection and account.");
      }
    }
    void load();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [blob, path, token, open]);
  function toggle() { setSource(null); setError(""); setOpen(!open); }
  return h("div", { className: "stack" },
    h("button", { className: "btn secondary", type: "button", "aria-expanded": open, onClick: toggle }, (open ? "Close · " : "Play · ") + caption),
    open && (source ? h("video", { controls: true, playsInline: true, src: source, style: { width: "100%", maxHeight: "55vh" }, "aria-label": caption })
      : h("p", { role: "status" }, error || "Loading video…")));
}

function ArchivedClips({ archive, token }) {
  return archive?.clips?.length > 0 && h("section", { className: "card stack" },
    h("h3", { className: "section" }, "Uploaded videos"),
    archive.clips.map((clip) => h(ClipPreview, { key: clip.id, caption: "Hole " + clip.hole + " · " + clip.playerName,
      path: clip.mediaPath, token })));
}

function useArchive(roundId, connection) {
  const { account, online } = connection;
  const token = account?.token;
  const [result, setResult] = React.useState(null);
  React.useEffect(() => {
    if (!roundId || !token || !online || !account.active) return undefined;
    let controller;
    async function load() {
      controller?.abort();
      const request = controller = new AbortController();
      const reply = await offlineRequest("/offline-rounds/" + roundId, token, { signal: request.signal });
      if (!request.signal.aborted && sameOfflineOwner(account, offlineAccount())) {
        setResult({ ...reply, ok: reply.ok && Boolean(reply.data?.round), token, roundId });
      }
    }
    window.addEventListener(CLIPS_EVENT, load);
    void load();
    return () => { controller?.abort(); window.removeEventListener(CLIPS_EVENT, load); };
  }, [roundId, token, account?.active, online]);
  return result?.roundId === roundId && result?.token === token ? result : null;
}

function RemoteRound({ id, connection }) {
  const result = useArchive(Number(id), connection);
  return h("div", { className: "stack" }, h(OfflineHeader, { title: "Personal offline round" }),
    result?.ok ? h(RoundSummary, { round: result.data.round })
      : h("p", { role: "status" }, result || !connection.online || !connection.account?.active
        ? "Connect with the account that saved this round to open it." : "Reading your saved round…"),
    result?.ok && h(ArchivedClips, { archive: result.data, token: connection.account?.token }));
}

function FinalRound({ round, connection, edit, onRetry, busy, notice, setNotice }) {
  const { account, online } = connection;
  const [linking, setLinking] = React.useState(false);
  const [name, setName] = React.useState("");
  const uploadClip = React.useCallback((record) => {
    const sent = uploadOfflineClip(round, offlineAccount(), record);
    return fieldTestOn() ? fieldTrackClip(sent, record, "offline") : sent;
  }, [round.receipt, round.owner]);
  const clips = useClipRecovery({ scopeKey: "offline-round:" + round.localId, upload: round.receipt ? uploadClip : CLOSED_CLIP_UPLOAD });
  const archive = useArchive(round.receipt?.id, connection);

  async function link() {
    if (busy || !linking || !account?.active) return;
    const verified = await offlineRequest("/offline-rounds", account.token);
    if (!verified.ok || !sameOfflineOwner(account, offlineAccount())) {
      setNotice("This account could not be verified. Sign in again and retry.");
      return;
    }
    setLinking(false);
    await edit((current) => {
      if (current.owner || current.startedAs !== "device") return current;
      return { ...current, owner: { kind: account.kind, id: account.id } };
    });
  }

  async function connectOpenPlay(event) {
    event.preventDefault();
    if (offlineAccount()) return;
    const reply = await openOfflineIdentity(name);
    setNotice(reply.ok ? "Open-play name connected. Choose Link round to upload this card." : "Could not connect an open-play name. Check the connection and try again.");
  }

  async function queueClip(record) {
    try { await clips.put({ ...record, state: "pending", nextAt: 0, error: null }); }
    catch (error) { setNotice(storageNotice(error)); }
  }

  return h("div", { className: "stack" },
    h(OfflineHeader, { title: "Finished offline round" }),
    h("p", { role: "status" }, uploadNotice(round, account)),
    notice && h("p", { role: "alert" }, notice),
    h(RoundSummary, { round }),
    h("p", { className: "muted" }, "This personal round uses your saved layout and stays outside club ratings and standings."),
    !round.receipt && (round.owner
      ? h(React.Fragment, null,
        !round.sealedAt && h("button", { className: "btn secondary", type: "button", disabled: busy,
          onClick: () => { void edit((row) => ({ ...row, finishedAt: null, retryAt: null, uploadError: null })); } }, "Reopen round"),
        h("button", { className: "btn secondary", type: "button", disabled: !online || !account?.active || busy, onClick: () => onRetry(round) }, "Retry upload"),
        !account?.active && round.owner.kind === "member" && h("a", { className: "btn secondary", href: signInFor(round.localId) }, "Sign in to scoring"))
      : h(React.Fragment, null,
        h("button", { className: "btn secondary", type: "button", disabled: busy,
          onClick: () => { void edit((row) => ({ ...row, finishedAt: null })); } }, "Reopen round"),
        account?.active
          ? (linking ? h("section", { className: "card stack" },
            h("p", null, "Link this round to " + account.name + "? Future uploads use this account."),
            h("button", { className: "btn", type: "button", disabled: !online, onClick: link }, "Confirm link"),
            h("button", { className: "btn secondary", type: "button", onClick: () => setLinking(false) }, "Keep on this device"))
            : h("button", { className: "btn secondary", type: "button", disabled: !online, onClick: () => setLinking(true) }, "Link round to " + account.name))
          : h(React.Fragment, null, h("a", { className: "btn secondary", href: signInFor(round.localId) }, "Sign in to scoring"),
            online && !account && h("form", { className: "card stack", onSubmit: connectOpenPlay },
              h("label", { className: "lbl" }, "Open-play name",
                h("input", { className: "field", required: true, maxLength: 60, value: name, onChange: (event) => setName(event.target.value) })),
              h("button", { className: "btn secondary", type: "submit" }, "Connect open-play name"))))),
    h("button", { className: "btn secondary", type: "button", onClick: () => exportLocal(round) }, "Download round data"),
    clips?.storageError && h("p", { role: "alert" }, "Device video storage could not be read."),
    clips?.drafts.length > 0 && h("section", { className: "card stack" },
      h("h3", { className: "section" }, "Videos on this device"),
      clips.drafts.map((record) => h("div", { className: "stack", key: record.id },
        h(ClipPreview, { caption: "Hole " + record.hole + " · " + round.players[record.playerIndex]?.name, blob: record.blob }),
        h("p", { className: "muted" }, record.state === "pending" ? "Waiting to upload." : record.state === "draft" ? "Saved draft." : "Upload needs attention. The video is still on this device."),
        record.state !== "pending" && h("button", { type: "button", className: "btn secondary",
          disabled: !round.receipt || !online, onClick: () => queueClip(record) }, record.state === "draft" ? "Upload clip" : "Retry clip")))),
    h(ArchivedClips, { archive: archive?.data, token: account?.token }));
}

function ActiveRound({ round, edit, busy, notice }) {
  const [hole, setHole] = React.useState(() => {
    const firstUnscored = offlineRoundOutcome(round).missing[0]?.hole;
    return Math.max(0, round.source.holes.findIndex((entry) => entry.hole === firstUnscored));
  });
  const [finish, setFinish] = React.useState(false);
  const [review, setReview] = React.useState(false);
  const closeReview = () => setReview(false);
  const reviewDialog = useAccessibleDialog({ open: review, onClose: closeReview, labelledBy: "offline-scorecard-title", label: "Full scorecard" });
  const props = offlineScorecard(round, hole, finish);
  const targets = offlineTargets(round);
  const clipRows = round.players.map((player, index) => {
    const target = targets.find((row) => row.playerIndexes.includes(index));
    return { key: player.id, label: player.name, isMe: index === 0, currentScore: round.scores[target.id]?.[props.hole.hole], source: { index } };
  });
  function setScore(row, holeNumber, strokes, _scorerIndex, step) {
    if (strokes != null && (!Number.isInteger(strokes) || strokes < 1 || strokes > 30)) return;
    const id = row.targetId || "player:" + row.index;
    if (!targets.some((target) => target.id === id)) return;
    void edit((current) => {
      if (current.finishedAt) return current;
      const scores = { ...current.scores[id] };
      const par = current.source.holes.find((entry) => entry.hole === holeNumber)?.par;
      const value = step === "plus" || step === "minus" ? nextHoleScore(scores[holeNumber] ?? null, par, step) : strokes;
      if (value == null) delete scores[holeNumber];
      else scores[holeNumber] = value;
      return { ...current, scores: { ...current.scores, [id]: scores } };
    });
  }
  function saveShots(model, rows) {
    const value = parseShotRows(rows);
    return value && edit((current) => ({ ...current, shots: { ...current.shots, [model.hole]: value } }), model.revision);
  }
  const jump = (index) => { setReview(false); setHole(Math.max(0, Math.min(round.source.holes.length - 1, index))); };
  async function complete() {
    const saved = await edit((current) => {
      if (!offlineRoundOutcome(current).complete) return current;
      return { ...current, finishedAt: new Date(Math.max(Date.now(), Date.parse(current.startedAt))).toISOString() };
    });
    fieldLog("round.finish", { mode: "offline", roundId: round.localId, result: saved ? "saved" : "error" });
  }
  const status = h("div", { key: "offline-status", style: { padding: "0 .35rem", flexShrink: 0 } },
    h("a", { className: "btn ghost small", style: { textDecoration: "none", marginInlineEnd: ".4rem" }, href: HUB }, "Offline rounds"),
    h("span", { className: "muted", role: "status" }, busy ? "Saving on this device…" : "Scoring on this device"),
    notice && h("p", { role: "alert" }, notice));
  return h(React.Fragment, null,
    review && createPortal(h("div", { className: "overlay", "data-a11y-overlay": "true", role: "presentation", ref: reviewDialog.overlayRef },
      h("section", { className: "sheet", role: "dialog", "aria-modal": reviewDialog.isolated ? "true" : undefined,
        "aria-labelledby": "offline-scorecard-title", tabIndex: -1, ref: reviewDialog.panelRef, style: { maxHeight: "85vh", overflow: "auto" } },
        h("h2", { className: "section", id: "offline-scorecard-title" }, "Full scorecard"),
        h(RoundSummary, { round }),
        h("button", { className: "btn secondary sheet-close", type: "button", onClick: closeReview }, "Back to round"))), document.body),
    h(ScorecardView, { ...props, lostFoundCourseId: round.source.courseId, offlineStatus: status, finishing: busy, clipRows, clipRecovery: { scopeKey: "offline-round:" + round.localId, upload: CLOSED_CLIP_UPLOAD },
      onNext: () => jump(hole + 1), onPrevious: () => jump(hole - 1), onJumpHole: jump, onScore: setScore,
      onFullScorecard: () => setReview(true), onOpenFinish: () => setFinish(true), onCloseFinish: () => setFinish(false),
      onAgreeFinish: complete, onSaveShots: saveShots,
      onThrows: (holeNumber, change) => {
        void edit((current) => current.finishedAt ? current : ({
          ...current, marks: { ...current.marks, [holeNumber]: change(current.marks[holeNumber] || []) },
        }));
      },
    }));
}

function LocalRound({ id, connection, onScoring }) {
  const [round, setRound] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const queue = React.useRef({ tail: Promise.resolve(), pending: 0, generation: 0, alive: false });
  const latest = React.useRef(null);
  const { account } = connection;
  const ownerKey = account ? account.kind + ":" + account.id : "device";
  const allowed = round && (!round.owner || sameOfflineOwner(account, round.owner));
  const scoring = Boolean(allowed && !round.finishedAt);
  const refresh = React.useCallback(async () => {
    try {
      const row = await offlineRoundStore.get(id);
      if (!queue.current.alive) return;
      latest.current = row;
      setRound(row);
    } catch (error) { if (queue.current.alive) setNotice(storageNotice(error)); }
    finally { if (queue.current.alive) setLoading(false); }
  }, [id]);
  React.useEffect(() => {
    const currentQueue = queue.current;
    currentQueue.alive = true;
    void refresh();
    return () => { currentQueue.alive = false; currentQueue.generation += 1; };
  }, [refresh]);
  React.useEffect(() => {
    const currentQueue = queue.current;
    currentQueue.generation += 1;
    void currentQueue.tail.then(() => { if (currentQueue.alive) return refresh(); });
  }, [ownerKey, refresh]);
  React.useEffect(() => { onScoring(scoring); return () => onScoring(false); }, [onScoring, scoring]);
  const applied = React.useCallback((row) => { latest.current = row; setRound(row); }, []);
  const retry = useArchiveSync(allowed ? [round] : [], connection, applied, setNotice);
  function edit(change, expected) {
    const currentQueue = queue.current;
    if (!latest.current) return Promise.resolve(false);
    const generation = currentQueue.generation;
    const initialOwner = offlineAccount();
    currentQueue.pending += 1;
    setBusy(true);
    setNotice("");
    const run = currentQueue.tail.then(async () => {
      if (!currentQueue.alive || generation !== currentQueue.generation || !latest.current) return false;
      const owner = offlineAccount();
      if ((initialOwner || owner) && !sameOfflineOwner(initialOwner, owner)) {
        setNotice(storageNotice({ code: "offline_owner_mismatch" }));
        currentQueue.generation += 1;
        return false;
      }
      try {
        const saveMark = fieldMark();
        const row = await offlineRoundStore.update(id, expected ?? latest.current.revision, owner, change);
        if (saveMark) fieldLog("offline.save", { roundId: id, ms: fieldSince(saveMark) });
        if (currentQueue.alive && generation === currentQueue.generation) applied(row);
        return true;
      } catch (error) {
        if (!currentQueue.alive || generation !== currentQueue.generation) return false;
        setNotice(storageNotice(error));
        currentQueue.generation += 1;
        if (error?.code === "local_round_changed" || error?.code === "offline_round_sealed") await refresh();
        return false;
      }
    }).finally(() => {
      currentQueue.pending -= 1;
      if (currentQueue.alive && !currentQueue.pending) setBusy(false);
    });
    currentQueue.tail = run.catch(() => false);
    return currentQueue.tail;
  }
  if (loading || !allowed) return h("div", { className: "stack" }, h(OfflineHeader, { title: "Offline round" }),
    h("p", { role: "status" }, notice || (loading ? "Reading the round on this device…" : "This round is unavailable on this device under this account.")));
  return scoring ? h(ActiveRound, { round, edit, busy, notice })
    : h(FinalRound, { key: account?.id || "device", round, connection, edit, onRetry: retry, busy, notice, setNotice });
}

export function OfflineRoundView({ route, onScoring }) {
  const connection = useConnection();
  if (route.invalid) return h("div", { className: "stack" }, h(OfflineHeader, { title: "This offline round link is invalid." }));
  if (route.localId) return h(LocalRound, { key: route.localId, id: route.localId, connection, onScoring });
  if (route.archive) return h(RemoteRound, { id: route.archive, connection });
  return h(OfflineHub, { route, connection });
}
