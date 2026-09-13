import { createLeaderboardSheetRenderer } from "./leaderboard-sheet.js";
import { createManagePlayersSheetRenderer } from "./manage-players-sheet.js";
import { createScoreDialogRenderer } from "./dialogs.js";
import { createScoreNotificationsRenderer } from "./notifications.js";
import {
    activeHoleIndex,
    buildScorecardViewState,
    cardHoleComplete,
    fieldActiveHoleIndex,
    finalizeBlockers,
    finishRoundHint,
    isDoublesScoring,
    isMatchplayScoring,
    relClass,
    relText,
    scorePendingKey as pendingKey,
    scoreTargetForPlayer,
    scorecardChoices,
    udiscExportData,
} from "./score-view-model.js";
import { resolveApiBase } from "../shared/api-base.js";
import { buildLivePots, withLiveCtpLeaders } from "../shared/live-pots-model.js";
import { isLiveWatchRequest, liveRoundCodeFromSearch, liveScoreHref, liveWatchHref } from "../shared/live-watch.js";
import { holeWinners, winnerColor } from "../shared/matchplay-colors.js";
import { notifyScoreAuthChanged } from "../shared/player-theme-session.js";

export function startScoreApp(options) {
        "use strict";
        options = options || {};
        const API_BASE = resolveApiBase({ datasetKeys: ['apiBase'] });

        const TOKEN_KEY = 'gvdg_member_token', NAME_KEY = 'gvdg_member_name', GUESTREG_KEY = 'gvdg_guest_regs', RECENT_ROUNDS_KEY = 'gvdg_recent_rounds';
        const params = new URLSearchParams(location.search);
        const EVENT_ID = (params.get('event') || '').replace(/[^0-9]/g, '');
        const ROUND_CODE = liveRoundCodeFromSearch(params);
        const MODE = ROUND_CODE ? 'round' : (EVENT_ID ? 'event' : 'home'); // event scoring · casual round · home
        const WATCH = isLiveWatchRequest(params);
        const LIVE = ROUND_CODE ? ('/rounds/' + ROUND_CODE + '/live') : ('/events/' + EVENT_ID + '/live');
        // A guest scores an EVENT via their registration token (URL ?gt= or saved at registration); casual
        // rounds are members-only, so there is no guest token there.
        function guestTokenStored() { try { const a = JSON.parse(localStorage.getItem(GUESTREG_KEY) || '{}'); return (a[EVENT_ID] && a[EVENT_ID].guestToken) || null; } catch (e) { return null; } }
        const GUEST_TOKEN = MODE === 'event' ? (params.get('gt') || guestTokenStored()) : null;

        const dialogs = createScoreDialogRenderer();
        const notifications = createScoreNotificationsRenderer();
        const scoreBody = options && options.body;
        const scoreShell = options && options.shell;
        const POTS_REFRESH_MS = 30 * 1000;
        const S = { holes: [], cardId: null, myIndex: null, scorerIndex: null, cardmates: [], snap: null, holeIdx: 0, ws: null, wsTimer: null, status: null, conflicts: [], missing: [], courseName: null, layoutName: null, lastRev: -1, udiscCourseId: null, roundConfig: null, scoreTargets: [], scoreTargetError: null, weather: null, pots: null, playerLocations: [] };
        let potsTimer = null;
        let locWatchId = null;
        let locLastSent = 0;
        const pending = new Map();            // pendingKey -> in-flight count (refcount: concurrent taps on one cell each stay protected until their own POST returns)
        const QKEY = 'gvdg_score_queue:' + (ROUND_CODE || EVENT_ID);

        // ---------- tiny helpers ----------
        function memberToken() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
        function rememberRecentRound(entry) {
            try {
                if (!entry || !entry.code) return;
                const key = String(entry.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
                if (!key) return;
                const rows = JSON.parse(localStorage.getItem(RECENT_ROUNDS_KEY) || '[]');
                const next = [{ code: key, label: entry.label || ('Casual round ' + key), updatedAt: Date.now() }]
                    .concat((Array.isArray(rows) ? rows : []).filter((row) => String(row && row.code || '').toUpperCase() !== key))
                    .slice(0, 12);
                localStorage.setItem(RECENT_ROUNDS_KEY, JSON.stringify(next));
            } catch (e) {}
        }
        function toast(msg) {
            notifications.showToast(msg);
        }
        // A loud, sticky, top-of-screen alert (with a buzz) when the card has a scoring conflict. Tap to dismiss.
        function conflictAlert(msg) {
            if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) {} }
            const values = Array.isArray(msg.values) && msg.values.length ? msg.values.join(' vs ') : ((msg.from != null && msg.to != null) ? (msg.from + ' vs ' + msg.to) : 'scores do not match');
            const text = 'Scoring conflict - Hole ' + msg.hole + ', ' + (msg.playerName || 'a player') + ': ' + values + '. Confirm with your card.';
            notifications.showConflict(text);
        }

        function setShellHeader(nextHeader) {
            if (scoreShell && typeof scoreShell.setHeader === 'function') scoreShell.setHeader(nextHeader);
        }
        function resetShellHeader() {
            setShellHeader({ showLeaderboard: false, subtitle: 'Greenville Disc Golf Club', title: 'Live Scoring' });
        }

        // ---------- API (member Bearer token OR guest ?gt=/guestToken) ----------
        async function api(path, opts) {
            opts = opts || {};
            const headers = {};
            let url = path;
            const tok = memberToken();
            if (tok && opts.auth !== false) headers['Authorization'] = 'Bearer ' + tok;
            else if (!tok && GUEST_TOKEN && opts.guest !== false) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'gt=' + encodeURIComponent(GUEST_TOKEN);
            let body = opts.body;
            if (body !== undefined) {
                headers['Content-Type'] = 'application/json';
                if (!tok && GUEST_TOKEN && body && typeof body === 'object') body = Object.assign({ guestToken: GUEST_TOKEN }, body);
                body = JSON.stringify(body);
            }
            let r;
            try { r = await fetch(API_BASE + url, { method: opts.method || 'GET', headers, body, cache: 'no-store' }); }
            catch (e) { return { ok: false, status: 0, data: null, neterr: true }; }
            let data = null; try { data = await r.json(); } catch (e) {}
            return { ok: r.ok, status: r.status, data };
        }

        async function loadPots() {
            if (!EVENT_ID) {
                S.pots = null;
                return;
            }
            const [ctpsRes, aceRes] = await Promise.all([
                api('/events/' + EVENT_ID + '/ctps', { auth: false, guest: false }),
                api('/events/' + EVENT_ID + '/ace-pot', { auth: false, guest: false }),
            ]);
            S.pots = {
                acePot: aceRes.ok && aceRes.data ? aceRes.data.ace_pot : null,
                ctps: withLiveCtpLeaders(
                    ctpsRes.ok && Array.isArray(ctpsRes.data && ctpsRes.data.ctps) ? ctpsRes.data.ctps : [],
                    S.snap && S.snap.liveCtps,
                ),
            };
        }
        function startPotsPolling() {
            if (!EVENT_ID || potsTimer != null) return;
            void refreshPots();
            potsTimer = setInterval(function () { void refreshPots(); }, POTS_REFRESH_MS);
        }
        async function refreshPots() {
            await loadPots();
            if (WATCH) renderWatch();
            else if (S.holes.length) renderHole();
        }

        function stopLiveLocation() {
            if (locWatchId != null && navigator.geolocation) {
                try { navigator.geolocation.clearWatch(locWatchId); } catch (e) {}
            }
            locWatchId = null;
        }
        function startLiveLocation() {
            if (WATCH || locWatchId != null) return;
            if (!memberToken()) return;
            if (!navigator.geolocation) return;
            locWatchId = navigator.geolocation.watchPosition(function (pos) {
                const lat = pos.coords && pos.coords.latitude;
                const lng = pos.coords && pos.coords.longitude;
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
                const now = Date.now();
                if (now - locLastSent < 8000) return;
                locLastSent = now;
                void api(LIVE + '/location', { method: 'POST', body: { lat: lat, lng: lng } }).then(function (r) {
                    if (r.status === 401 || r.status === 403 || r.status === 409) stopLiveLocation();
                });
            }, function (err) {
                if (err && err.code === 1) stopLiveLocation();
            }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
        }

        function locationStamp(rows) {
            let max = 0;
            (Array.isArray(rows) ? rows : []).forEach(function (row) {
                const at = Number(row && row.at);
                if (Number.isFinite(at) && at > max) max = at;
            });
            return max;
        }
        function applyPlayerLocations(next) {
            const rows = Array.isArray(next) ? next : [];
            if (!rows.length) {
                const changed = (S.playerLocations || []).length > 0;
                S.playerLocations = [];
                return changed;
            }
            if (locationStamp(rows) < locationStamp(S.playerLocations)) return false;
            S.playerLocations = rows;
            return true;
        }
        function applyLiveExtras(snap) {
            const weatherChanged = Object.prototype.hasOwnProperty.call(snap, 'weather');
            if (weatherChanged) S.weather = snap.weather || null;
            const locationsChanged = Object.prototype.hasOwnProperty.call(snap, 'playerLocations')
                ? applyPlayerLocations(snap.playerLocations)
                : false;
            return weatherChanged || locationsChanged;
        }

        // ---------- offline score queue ----------
        function qLoad() { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch (e) { return []; } }
        function qSave(q) { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch (e) {} }
        function qAdd(item) { const q = qLoad(); q.push(item); qSave(q); }
        let flushQueuePromise = null;
        async function flushQueue() {
            if (flushQueuePromise) return flushQueuePromise;
            flushQueuePromise = (async function () {
                let q = qLoad(); if (!q.length) return;
                const remain = [];   // transient failures (network / 5xx) — keep to retry
                const rejected = []; // permanent server rejections (4xx) — CANNOT retry; must tell the scorer
                for (const item of q) {
                    const body = { hole: item.hole, strokes: item.strokes };
                    if (item.targetId) body.targetId = item.targetId;
                    else body.index = item.index;
                    if (Number.isInteger(item.scorerIndex)) body.scorerIndex = item.scorerIndex;
                    // Protect the queued optimistic value with the same pending refcount so an interim WS snapshot
                    // (which doesn't have this score yet) can't wipe it mid-replay.
                    const key = Number.isInteger(item.scorerIndex) ? pendingKey(item.scorerIndex, item.targetId ? null : item.index, item.hole, item.targetId || null) : null;
                    if (key) pending.set(key, (pending.get(key) || 0) + 1);
                    const r = await api(LIVE + '/score', { method: 'POST', body: body });
                    if (key) { const m = (pending.get(key) || 0) - 1; if (m > 0) pending.set(key, m); else pending.delete(key); }
                    if (r.ok) S.snap = r.data;
                    else if (r.neterr || r.status >= 500) remain.push(item); // transient — retry on next flush
                    else rejected.push(item); // 4xx (bad hole / not-your-card / consensus conflict): drop, but surface it
                }
                qSave(remain);
                mergeFromSnap(); // reconcile the card with the server once the queue has drained
                if (rejected.length) {
                    // Never silently lose a score AND never lie with a "Synced" toast. Tell the scorer exactly
                    // which holes the server refused so they can re-enter them.
                    const holes = rejected.map(function (it) { return it.hole; }).sort(function (a, b) { return a - b; }).join(', ');
                    notifications.showConflict(
                        rejected.length + ' offline score' + (rejected.length > 1 ? 's were' : ' was') +
                        ' rejected and NOT saved (hole' + (rejected.length > 1 ? 's' : '') + ' ' + holes + '). Please re-enter. Tap to dismiss.');
                    if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) {} }
                } else if (q.length && !remain.length) {
                    toast('Synced offline scores');
                }
            })();
            try { return await flushQueuePromise; }
            finally { flushQueuePromise = null; }
        }

        // ---------- offline bar ----------
        function setOnline(on) {
            notifications.setOnline(on);
        }
        window.addEventListener('online', function () { setOnline(true); flushQueue(); connectWs(); });
        window.addEventListener('offline', function () { setOnline(false); });

        // ---------- score state access ----------
        function currentScorerIndex() {
            const choices = scorecardChoices(S);
            if (!choices.length) return null;
            if (choices.some((p) => p.index === S.scorerIndex)) return S.scorerIndex;
            const mine = choices.find((p) => p.index === S.myIndex);
            S.scorerIndex = (mine || choices[0]).index;
            return S.scorerIndex;
        }
        function hasPendingScore(index, hole) {
            const legacySuffix = ':index:' + index + ':' + hole;
            for (const key of pending.keys()) {
                if (key.endsWith(legacySuffix)) return true;
                const target = scoreTargetForPlayer(S, index);
                if (target && key.endsWith(':target:' + target.id + ':' + hole)) return true;
            }
            return false;
        }
        function setLocal(index, hole, strokes) {
            const cm = S.cardmates.find((p) => p.index === index);
            if (!cm) return;
            // Optimistically record the SELECTED scorecard's own vote (not the consensus) so the number sticks
            // and can be incremented during a conflict instead of snapping back to blank.
            const sIdx = currentScorerIndex();
            cm.scorecards = cm.scorecards || {};
            cm.scorecards[hole] = Object.assign({}, cm.scorecards[hole]);
            if (sIdx != null) {
                if (strokes == null) delete cm.scorecards[hole]['player:' + sIdx];
                else cm.scorecards[hole]['player:' + sIdx] = strokes;
            }
            cm.scores = cm.scores || {};
            if (strokes == null) delete cm.scores[hole];
            else cm.scores[hole] = strokes;
        }
        function setLocalRow(row, hole, strokes) {
            (row.playerIndexes || []).forEach(function (index) { setLocal(index, hole, strokes); });
        }
        function setConflicts(rows) {
            S.conflicts = (Array.isArray(rows) ? rows : []).filter((c) => c && c.cardId === S.cardId);
        }
        function setMissing(rows) {
            // Holes with no living consensus score yet (guests are optional). Drives the
            // "what's blocking finalize" panel; scoped to our own card.
            S.missing = (Array.isArray(rows) ? rows : []).filter((m) => m && m.cardId === S.cardId);
        }
        function upsertConflict(msg) {
            if (!msg || msg.cardId !== S.cardId) return;
            S.conflicts = S.conflicts.filter((c) => !((msg.targetId && c.targetId === msg.targetId || !msg.targetId && c.playerIndex === msg.playerIndex) && c.hole === msg.hole));
            if (Array.isArray(msg.values) && msg.values.length > 1) S.conflicts.push({ cardId: msg.cardId, playerIndex: msg.playerIndex, playerName: msg.playerName, targetId: msg.targetId, label: msg.label, hole: msg.hole, values: msg.values });
        }

        async function postScore(row, hole, strokes) {
            const scorerIndex = currentScorerIndex();
            if (scorerIndex == null) { toast('Choose a scorecard'); return; }
            const key = pendingKey(scorerIndex, row.index, hole, row.targetId || null);
            // Snapshot the cell's prior value so a rejection can be rolled back even before any snapshot exists.
            const previous = (row.playerIndexes || []).map(function (index) {
                const cm = S.cardmates.find((p) => p.index === index);
                return {
                    cm: cm,
                    vote: cm && cm.scorecards && cm.scorecards[hole] ? cm.scorecards[hole]['player:' + scorerIndex] : undefined,
                    score: cm && cm.scores ? cm.scores[hole] : undefined
                };
            });
            pending.set(key, (pending.get(key) || 0) + 1); // refcount so a later concurrent tap stays protected
            setLocalRow(row, hole, strokes);
            renderHole();
            const body = { scorerIndex: scorerIndex, hole: hole, strokes: strokes };
            if (row.targetId) body.targetId = row.targetId;
            else body.index = row.index;
            const r = await api(LIVE + '/score', { method: 'POST', body: body });
            const n = (pending.get(key) || 0) - 1; if (n > 0) pending.set(key, n); else pending.delete(key);
            if (r.ok) { S.snap = r.data; mergeFromSnap(); }
            else if (r.neterr) { qAdd(row.targetId ? { targetId: row.targetId, scorerIndex: scorerIndex, hole: hole, strokes: strokes } : { index: row.index, scorerIndex: scorerIndex, hole: hole, strokes: strokes }); setOnline(false); }
            else {
                if (r.status === 403) toast('You can only score your own card');
                else if (r.status === 401) toast('Session expired — sign in again');
                else if (r.status === 429) toast('Easy there — one moment');
                else if (r.status === 409) toast('Round isn’t live');
                else toast('Could not save that score');
                // Rejected — roll the phantom optimistic vote back. Reconcile from the snapshot if we have one;
                // otherwise (no snapshot yet) restore the captured prior value directly.
                if (S.snap) mergeFromSnap();
                previous.forEach(function (prev) {
                    const cm0 = prev.cm; if (!cm0) return;
                    cm0.scorecards = cm0.scorecards || {}; cm0.scorecards[hole] = Object.assign({}, cm0.scorecards[hole]);
                    if (prev.vote === undefined) delete cm0.scorecards[hole]['player:' + scorerIndex]; else cm0.scorecards[hole]['player:' + scorerIndex] = prev.vote;
                    cm0.scores = cm0.scores || {};
                    if (prev.score === undefined) delete cm0.scores[hole]; else cm0.scores[hole] = prev.score;
                });
                renderHole();
            }
        }

        // ---------- merge a snapshot's scores into our cardmates (respecting pending optimistic edits) ----------
        // My own score-target error: a whole-round error (public scoreTargetError) else the per-pair error
        // covering MY player index. The public snapshot narrows scoreTargetError to null on a per-PAIR break
        // (so it can't bleed to every viewer over /ws), exposing the detail in the additive scoreTargetErrors[]
        // — deriving from it here keeps a broken-pair member's banner alive across WS snapshots while a healthy
        // pair on the same card stays clear.
        function myScoreTargetError(snap) {
            if (snap && snap.scoreTargetError) return snap.scoreTargetError;
            const errs = snap && Array.isArray(snap.scoreTargetErrors) ? snap.scoreTargetErrors : [];
            if (!errs.length) return null;
            const mine = S.myIndex != null ? errs.find((e) => e && Array.isArray(e.playerIndexes) && e.playerIndexes.indexOf(S.myIndex) >= 0) : null;
            return mine || errs.find((e) => e && (e.cardId ?? null) === S.cardId) || null;
        }
        function mergeFromSnap() {
            const snap = S.snap; if (!snap || !Array.isArray(snap.players)) return;
            if (WATCH) {
                const extrasChanged = applyLiveExtras(snap);
                if (snap.status === 'final') stopLiveLocation();
                if (snap.rev != null) { if (snap.rev <= S.lastRev) { if (extrasChanged) renderWatch(); return; } S.lastRev = snap.rev; }
                if (snap.status) S.status = snap.status;
                S.roundConfig = snap.roundConfig || S.roundConfig;
                if (S.pots) S.pots.ctps = withLiveCtpLeaders(S.pots.ctps, snap.liveCtps);
                renderWatch();
                return;
            }
            const extrasChanged = applyLiveExtras(snap);
            if (snap.status === 'final') stopLiveLocation();
            // Drop a stale/out-of-order snapshot (a newer one from another device was already applied).
            if (snap.rev != null) { if (snap.rev <= S.lastRev) { if (extrasChanged) renderHole(); return; } S.lastRev = snap.rev; }
            if (snap.status) S.status = snap.status; // reflect a finalize (or start) that happened on another device
            S.roundConfig = snap.roundConfig || S.roundConfig;
            S.scoreTargets = Array.isArray(snap.scoreTargets) ? snap.scoreTargets : S.scoreTargets;
            S.scoreTargetError = myScoreTargetError(snap);
            setConflicts(snap.conflicts);
            setMissing(snap.missing);
            if (S.pots) S.pots.ctps = withLiveCtpLeaders(S.pots.ctps, snap.liveCtps);
            const byIndex = new Map(snap.players.map((p) => [p.index, p]));
            // Card roster changed (a player was removed elsewhere, or a new walk-on/cardmate joined on
            // another device)? The snapshot omits removed players and includes new ones; rebuild from /mine
            // (which carries isMe/canEnterScorecard the public snapshot lacks) so removed players don't
            // linger as ghost rows, joins appear, and a selector pointing at a removed scorer is reset.
            const snapMine = snap.players.reduce((indexes, p) => { if ((p.cardId ?? null) === S.cardId) indexes.push(p.index); return indexes; }, []).sort((a, b) => a - b);
            const haveMine = S.cardmates.map((c) => c.index).sort((a, b) => a - b);
            if (snapMine.join(',') !== haveMine.join(',')) { loadMine(); return; }
            S.cardmates.forEach((cm) => {
                const sp = byIndex.get(cm.index); if (!sp) return;
                cm.scores = cm.scores || {};
                cm.scorecards = cm.scorecards || {};
                S.holes.forEach((hh) => {
                    // Consensus value (drives totals/leaderboard + the fallback display).
                    if (!hasPendingScore(cm.index, hh.hole)) {
                        const scores = sp.scores || {};
                        if (Object.prototype.hasOwnProperty.call(scores, hh.hole)) cm.scores[hh.hole] = scores[hh.hole];
                        else delete cm.scores[hh.hole];
                    }
                    // Per-scorer votes: the snapshot is the source of truth, but keep any of OUR own in-flight
                    // (pending) optimistic votes so the number doesn't flicker back while a POST is in flight.
                    const votes = Object.assign({}, (sp.scorecards && sp.scorecards[hh.hole]) || {});
                    const local = cm.scorecards[hh.hole] || {};
                    Object.keys(local).forEach((sid) => {
                        const sidx = sid.indexOf('player:') === 0 ? Number(sid.slice(7)) : NaN;
                        const target = scoreTargetForPlayer(S, cm.index);
                        if (Number.isInteger(sidx) && (pending.has(pendingKey(sidx, cm.index, hh.hole, null)) || (target && pending.has(pendingKey(sidx, null, hh.hole, target.id))))) votes[sid] = local[sid];
                    });
                    if (Object.keys(votes).length) cm.scorecards[hh.hole] = votes; else delete cm.scorecards[hh.hole];
                });
            });
            renderHole();
            if (lbOpen) renderLeaderboard();
            if (managePlayersOpen) renderManagePlayers();
        }

        // ---------- WebSocket live sync ----------
        function connectWs() {
            if (MODE === 'home') return;
            try { if (S.ws) S.ws.close(); } catch (e) {}
            let ws;
            try { ws = new WebSocket(API_BASE.replace(/^http/, 'ws') + LIVE + '/ws'); }
            catch (e) { return; }
            S.ws = ws;
            ws.addEventListener('message', function (ev) {
                let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
                // Two scorers on the same card disagreed on a hole — alert this card immediately to reconcile.
                if (msg && msg.type === 'conflict') { if (WATCH) return; if (msg.cardId === S.cardId) { upsertConflict(msg); conflictAlert(msg); renderHole(); } return; }
                if (msg && msg.type === 'snapshot') { S.snap = msg; mergeFromSnap(); }
            });
            ws.addEventListener('close', function () { if (S.wsTimer) return; S.wsTimer = setTimeout(function () { S.wsTimer = null; connectWs(); }, 4000); });
            ws.addEventListener('error', function () { try { ws.close(); } catch (e) {} });
        }

        // ---------- views ----------
        function renderScoreBody(kind, props) {
            if (!scoreBody || typeof scoreBody.render !== 'function') throw new Error('Missing score body renderer');
            scoreBody.render(kind, props);
        }
        function renderAuthFlow(props) {
            resetShellHeader();
            renderScoreBody('auth', props);
            return true;
        }
        function renderSetupFlow(props) {
            resetShellHeader();
            renderScoreBody('setup', props);
            return true;
        }
        function renderStatusView(props) {
            resetShellHeader();
            renderScoreBody('status', props);
            return true;
        }
        function renderLoading() {
            return renderStatusView({ mode: 'loading' });
        }
        function renderMessage(title, sub, withRetry) {
            renderStatusView({
                mode: 'message',
                onLeaderboard: openLeaderboard,
                onRetry: boot,
                sub: sub,
                title: title,
                withRetry: withRetry,
            });
        }

        // ---------- passkey login + forced PIN change (mirrors the members page) ----------
        function passkeysSupported() { return typeof window.PublicKeyCredential !== 'undefined'; }
        function b64urlToBuf(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); const pad = '='.repeat((4 - (s.length % 4)) % 4); const bin = atob(s + pad); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
        function bufToB64url(buf) { const u = new Uint8Array(buf); let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

        // Pre-fetch a passkey challenge while the login screen is up so the tap can call
        // navigator.credentials.get() with NO network in between (Safari/WebKit reject the prompt otherwise).
        let passkeyPrefetch = null; const PASSKEY_REFRESH_MS = 170000;
        async function prefetchPasskey() {
            if (!passkeysSupported()) return;
            if (passkeyPrefetch && Date.now() - passkeyPrefetch.ts < PASSKEY_REFRESH_MS) return;
            try { const r = await api('/webauthn/auth/options', { method: 'POST', auth: false, guest: false }); if (r.ok && r.data) passkeyPrefetch = { options: r.data.options, flowId: r.data.flowId, ts: Date.now() }; } catch (e) {}
        }
        async function loginWithPasskey() {
            if (!passkeysSupported()) return { ok: false, message: "Passkeys aren't supported on this device." };
            try {
                let options, flowId; const pf = passkeyPrefetch; passkeyPrefetch = null; // single use, no await before get()
                if (pf && Date.now() - pf.ts < 290000) { options = pf.options; flowId = pf.flowId; }
                else { const r = await api('/webauthn/auth/options', { method: 'POST', auth: false, guest: false }); if (!r.ok || !r.data) throw new Error('options'); options = r.data.options; flowId = r.data.flowId; }
                options.challenge = b64urlToBuf(options.challenge);
                if (options.allowCredentials) options.allowCredentials = options.allowCredentials.map(function (c) { return Object.assign({}, c, { id: b64urlToBuf(c.id) }); });
                const a = await navigator.credentials.get({ publicKey: options });
                const body = { flowId, response: { id: a.id, rawId: bufToB64url(a.rawId), type: a.type, response: { clientDataJSON: bufToB64url(a.response.clientDataJSON), authenticatorData: bufToB64url(a.response.authenticatorData), signature: bufToB64url(a.response.signature), userHandle: a.response.userHandle ? bufToB64url(a.response.userHandle) : undefined }, clientExtensionResults: a.getClientExtensionResults ? a.getClientExtensionResults() : {} } };
                const v = await api('/webauthn/auth/verify', { method: 'POST', auth: false, guest: false, body });
                if (v.status === 200 && v.data && v.data.token) { afterAuth(v.data); return { ok: true }; }
                return { ok: false, message: 'Passkey sign-in failed. Use your PIN instead.' };
            } catch (e) {
                return { ok: false, message: (e && e.name === 'NotAllowedError') ? 'Passkey sign-in cancelled.' : 'Passkey sign-in failed. Use your PIN instead.' };
            } finally { prefetchPasskey(); }
        }
        // After any successful auth (PIN or passkey): store the token, then force the PIN change if the
        // account still requires it — the must-change-PIN gate rejects EVERY protected route (incl. joining
        // a card), so without this a temp-PIN member logs in but gets bounced right back to the login screen.
        function afterAuth(data) {
            try { sessionStorage.setItem(TOKEN_KEY, data.token); if (data.name) sessionStorage.setItem(NAME_KEY, data.name); } catch (e) {}
            notifyScoreAuthChanged();
            if (data.mustChangePin) renderSetPin();
            else boot();
        }
        async function saveNewPin(newPin) {
            const r = await api('/set-pin', { method: 'POST', guest: false, body: { newPin: newPin } });
            if (r.status === 200 && r.data && r.data.token) {
                try { sessionStorage.setItem(TOKEN_KEY, r.data.token); } catch (e) {}
                notifyScoreAuthChanged();
                boot();
                return { ok: true };
            }
            if (r.status === 401) { renderLogin('Please sign in again.'); return { ok: true }; }
            return { ok: false, message: 'Could not update PIN - try again.' };
        }
        function renderSetPin(message) {
            renderAuthFlow({
                mode: 'setPin',
                message: message,
                onSetPin: saveNewPin
            });
        }

        async function loginWithPin(payload) {
            const r = await api('/login', { method: 'POST', auth: false, guest: false, body: { identifier: payload.identifier, pin: payload.pin } });
            if (r.ok && r.data && r.data.token) { afterAuth(r.data); return { ok: true }; }
            if (r.status === 423) return { ok: false, message: 'Too many attempts - try again in a few minutes.' };
            return { ok: false, message: r.status === 401 ? "That ID/PIN didn't match." : 'Sign-in failed - try again.' };
        }
        function renderLogin(message) {
            const supported = passkeysSupported();
            renderAuthFlow({
                guestAvailable: !!GUEST_TOKEN,
                membersHref: 'gvdg-members.html',
                message: message,
                mode: 'login',
                onGuestContinue: function () { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} notifyScoreAuthChanged(); boot(); },
                onLogin: loginWithPin,
                onPasskeyLogin: supported ? loginWithPasskey : null,
                passkeysSupported: supported
            });
            if (supported) {
                prefetchPasskey(); // warm the Worker + hold a challenge so the tap has no network before get()
            }
        }

        function holeMeta(idx) { return S.holes[idx] || { hole: idx + 1, par: 3 }; }
        function liveTeeSignView(h, players) {
            const id = Number(h && h.tee_sign_id);
            if (!id) return null;
            // Matchplay: tint this hole's tee sign in the winning team's color. Halved holes stay as-is
            // (no color) in the scoring app, per spec.
            let highlightColor = null;
            if (isMatchplayScoring(S)) {
                const w = holeWinners([{ hole: h.hole }], players || S.cardmates)[h.hole];
                const c = winnerColor(w, { tie: false });
                if (c) highlightColor = c;
            }
            return {
                alt: 'Tee sign for hole ' + h.hole,
                highlightColor: highlightColor,
                hole: h.hole,
                src: API_BASE + '/tee-signs/' + id + '/image',
            };
        }

        function watchHoleViews() {
            const players = (S.snap && S.snap.players) || S.cardmates || [];
            return (S.holes || []).map(function (h) {
                return {
                    hole: h.hole,
                    par: h.par,
                    distance_ft: h.distance_ft,
                    tee: h.tee,
                    target: h.target,
                    teeSign: liveTeeSignView(h, players),
                };
            });
        }

        async function postCtpVote(ctp, nomineeIndex) {
            const scorerIndex = currentScorerIndex();
            if (scorerIndex == null) { toast('Choose a scorecard'); return; }
            const r = await api(LIVE + '/ctp', { method: 'POST', body: { ctpId: Number(ctp.id), nomineeIndex: nomineeIndex, scorerIndex: scorerIndex } });
            if (r.ok) { S.snap = r.data; mergeFromSnap(); renderHole(); }
            else if (r.status === 403) toast('Everyone on this card has to agree — vote as yourself');
            else if (r.status === 401) toast('Session expired — sign in again');
            else if (r.status === 409) toast('Round isn’t live');
            else if (r.status === 404) toast('That CTP isn’t on this event');
            else if (r.data && r.data.error === "not_in_ctp") toast('That player isn’t in the CTP');
            else if (r.data && r.data.error === "wrong_division") toast('That CTP is a different division');
            else toast('Could not mark CTP');
        }
        function renderHole() {
            if (!S.holes.length) return;
            const h = holeMeta(S.holeIdx);
            const scorerIndex = currentScorerIndex();
            const scorecardState = buildScorecardViewState({
                state: S,
                mode: MODE,
                roundCode: ROUND_CODE,
                scorerIndex: scorerIndex,
                teeSign: liveTeeSignView(h),
            });
            renderScoreBody('scorecard', {
                ...scorecardState,
                onAddPlayer: addGuestPrompt,
                onJumpHole: function (index) { S.holeIdx = index; renderHole(); },
                onManagePlayers: openManagePlayers,
                onNext: function () { S.holeIdx = Math.min(S.holes.length - 1, S.holeIdx + 1); renderHole(); },
                onPrevious: function () { S.holeIdx = Math.max(0, S.holeIdx - 1); renderHole(); },
                onScore: postScore,
                onCtpVote: EVENT_ID && !WATCH ? postCtpVote : null,
                onScorerChange: function (index) { S.scorerIndex = index; renderHole(); },
                onShare: shareRound,
                onWatchShare: ROUND_CODE || EVENT_ID ? shareWatchLink : null,
            });
        }

        // ---------- leaderboard sheet ----------
        let lbOpen = false;
        const leaderboardSheet = createLeaderboardSheetRenderer();
        function openLeaderboard() { lbOpen = true; renderLeaderboard(); }
        if (scoreShell && typeof scoreShell.setLeaderboardHandler === 'function') scoreShell.setLeaderboardHandler(openLeaderboard);
        function closeLeaderboard() { lbOpen = false; leaderboardSheet.close(); }
        function renderLeaderboard() {
            const blockers = finalizeBlockers(S);
            blockers.hint = finishRoundHint(blockers, MODE);
            leaderboardSheet.render({
                blockers: blockers,
                exportData: udiscExportData(S),
                isDoubles: isDoublesScoring(S),
                isMatchplay: isMatchplayScoring(S),
                mode: MODE,
                onClose: closeLeaderboard,
                onFinalize: finalizeRound,
                relClass: relClass,
                relText: relText,
                standings: (S.snap && S.snap.standings) || [],
                status: S.status,
            });
        }
        async function finalizeRound() {
            const confirmed = await dialogs.confirm({
                cancelText: 'Keep scoring',
                confirmText: 'Finish round',
                message: 'This locks the scorecard for everyone.',
                title: 'Finish round?'
            });
            if (!confirmed) return;
            // Casual finalize is /rounds/<code>/finalize (NOT under /live). The Finish button only shows
            // for casual rounds; competition rounds are finalized by an admin from the admin console.
            const r = await api('/rounds/' + ROUND_CODE + '/finalize', { method: 'POST', body: {} });
            if (r.ok && r.data && r.data.status === 'final') {
                S.status = 'final';
                stopLiveLocation();
                toast('Round finished');
                if (lbOpen) renderLeaderboard();
            } else if (r.status === 409) {
                toast('Can’t finish yet — scorecards don’t agree');
                if (lbOpen) renderLeaderboard(); // reflect the latest blockers
            } else {
                toast('Couldn’t finish the round');
            }
        }

        // ---------- boot ----------
        async function loadMine() {
            let r = await api(LIVE + '/mine');
            // Casual round: if we're not on it yet, join with the code, then re-load our card.
            if (MODE === 'round' && r.ok && r.data && r.data.cardId == null && r.data.status === 'live') {
                const jr = await api('/rounds/' + ROUND_CODE + '/join', { method: 'POST', body: {} });
                if (jr.ok) r = await api(LIVE + '/mine');
            }
            if (r.status === 401) { renderLogin('Please sign in to keep score.'); return; }
            if (!r.ok || !r.data) { renderMessage('Couldn’t load your card', 'Check your connection and try again.', true); return; }
            const d = r.data;
            S.snap = d;
            S.status = d.status || null;
            if (d.cardId == null || !Array.isArray(d.cardmates) || !d.cardmates.length) {
                if (MODE === 'round') renderMessage('Round not found', 'That round code isn’t active. Double-check it, or start a new round.', true);
                else renderMessage('No card yet', 'Either the round hasn’t started or you’re not on a card for this event. Ask an admin to start the round and assign cards.', true);
                return;
            }
            S.holes = Array.isArray(d.holes) ? d.holes : [];
            S.cardId = d.cardId; S.myIndex = d.playerIndex; S.cardmates = d.cardmates;
            S.roundConfig = d.roundConfig || null; S.scoreTargets = Array.isArray(d.scoreTargets) ? d.scoreTargets : []; S.scoreTargetError = d.scoreTargetError || null;
            S.courseName = d.courseName || null; S.layoutName = d.layoutName || null; S.udiscCourseId = d.udiscCourseId || null;
            S.weather = d.weather || null;
            S.playerLocations = Array.isArray(d.playerLocations) ? d.playerLocations : [];
            S.scorerIndex = d.playerIndex;
            if (MODE === 'round') rememberRecentRound({ code: ROUND_CODE, label: 'Casual round ' + ROUND_CODE });
            currentScorerIndex();
            setConflicts(d.conflicts);
            setMissing(d.missing);
            const me = d.cardmates.find((p) => p.isMe);
            S.holeIdx = activeHoleIndex({
                holes: S.holes,
                startingHole: me && me.startingHole,
                isHoleComplete: function (hole) { return cardHoleComplete(S, hole, S.scorerIndex); },
            });
            setShellHeader({
                showLeaderboard: true,
                subtitle: [S.courseName, S.layoutName].filter(Boolean).join(' · ') || 'Greenville Disc Golf Club',
                title: MODE === 'round' ? ('Round ' + ROUND_CODE) : ('Card ' + (S.cardId || ''))
            });
            renderHole();
            connectWs();
            startPotsPolling();
            startLiveLocation();
            flushQueue();
        }

        // ---- casual round: home, course/layout pickers, create, add guest ----
        function cleanRoundCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
        function joinRoundCode(value) {
            const code = cleanRoundCode(value);
            if (code.length >= 4) location.search = '?round=' + code;
            else toast('Enter a valid code');
        }
        function signOut() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} notifyScoreAuthChanged(); renderLogin(); }
        function renderHome() {
            renderSetupFlow({
                view: 'home',
                onStart: renderCoursePick,
                onJoin: joinRoundCode,
                onWatch: watchRoundCode,
                onInvalidCode: function () { toast('Enter a valid code'); },
                onSignOut: signOut
            });
        }
        async function renderCoursePick() {
            renderLoading();
            const r = await api('/courses', { auth: false });
            const courses = (r.ok && r.data && r.data.courses) || [];
            renderSetupFlow({
                view: 'coursePick',
                courses: courses,
                onBack: renderHome,
                onSelect: renderLayoutPick
            });
        }
        async function renderLayoutPick(course) {
            renderLoading();
            const r = await api('/courses/' + encodeURIComponent(course.id) + '/layouts', { auth: false });
            const layouts = (r.ok && r.data && r.data.layouts) || [];
            renderSetupFlow({
                view: 'layoutPick',
                course: course,
                layouts: layouts,
                onBack: renderCoursePick,
                onSelect: function (layout) { renderSetupPick(course, layout); }
            });
        }
        function defaultLiveScoringConfig() {
            return { groupFormat: 'singles', scoringStyle: 'stroke' };
        }
        function renderSetupPick(course, layout) {
            renderSetupFlow({
                view: 'setupPick',
                course: course,
                layout: layout,
                defaultConfig: defaultLiveScoringConfig(),
                onBack: function () { renderLayoutPick(course); },
                onCreate: function (selected) { createRound(course, layout, selected); }
            });
        }
        async function createRound(course, layout, config) {
            renderLoading();
            const liveScoringConfig = config || defaultLiveScoringConfig();
            const r = await api('/rounds', { method: 'POST', body: { course_id: course.id, layout_id: layout.id, liveScoringConfig: { groupFormat: liveScoringConfig.groupFormat, scoringStyle: liveScoringConfig.scoringStyle } } });
            if (r.ok && r.data && r.data.code) { location.search = '?round=' + r.data.code; return; }
            renderMessage('Could not start round', (r.data && r.data.error === 'no_layout_holes') ? 'That layout has no holes/pars yet.' : 'Please try again.', false);
        }
        async function addGuestPrompt() {
            const name = await dialogs.prompt({
                confirmText: 'Add player',
                errorText: 'Enter a player name.',
                label: 'Player name',
                message: 'Add a walk-on player to this card.',
                placeholder: 'Player name',
                required: true,
                title: 'Add player'
            });
            if (!name) return;
            // Doubles requires a pair label per player — collect it now so the walk-on is pairable, rather
            // than leaving the round unscorable until someone opens Manage players.
            let team = null;
            if (isDoublesScoring(S)) {
                team = await dialogs.prompt({
                    confirmText: 'Add player',
                    errorText: 'Enter a pair label.',
                    label: 'Pair label for ' + name,
                    message: 'Use the same pair label for exactly two active players before scoring starts.',
                    placeholder: 'Pair label',
                    required: true,
                    title: 'Doubles pair label'
                });
                if (!team) { toast('Doubles needs a pair label for each player'); return; }
            }
            const r = await api('/rounds/' + ROUND_CODE + '/guest', { method: 'POST', body: team ? { name: name, team: team } : { name: name } });
            if (r.ok && r.data && Array.isArray(r.data.cardmates)) { S.cardmates = r.data.cardmates; currentScorerIndex(); renderHole(); toast(name + ' added'); }
            else toast('Could not add player');
        }
        // Manage players: remove someone who joined by accident, had to leave, or no-showed (casual round).
        let managePlayersOpen = false;
        const managePlayersSheet = createManagePlayersSheetRenderer();
        function openManagePlayers() { managePlayersOpen = true; renderManagePlayers(); }
        function closeManagePlayers() { managePlayersOpen = false; managePlayersSheet.close(); }
        function renderManagePlayers() {
            managePlayersSheet.render({
                isDoubles: isDoublesScoring(S),
                onClose: closeManagePlayers,
                onRemove: removeFromRound,
                onSavePairs: savePairLabels,
                players: S.cardmates || [],
            });
        }
        async function savePairLabels(assignments) {
            const r = await api('/rounds/' + ROUND_CODE + '/pairs', { method: 'POST', body: { assignments: assignments } });
            if (!r.ok) {
                if (r.status === 409) toast(r.data && r.data.error === 'scores_exist' ? 'Pair changes are blocked after scoring starts' : 'Could not save pairs');
                else if (r.status === 400 && r.data && r.data.message) toast(r.data.message);
                else toast('Could not save pairs');
                return;
            }
            closeManagePlayers();
            if (r.data) {
                S.cardId = r.data.cardId || S.cardId;
                S.myIndex = r.data.playerIndex == null ? S.myIndex : r.data.playerIndex;
                S.cardmates = Array.isArray(r.data.cardmates) ? r.data.cardmates : S.cardmates;
                S.roundConfig = r.data.roundConfig || S.roundConfig;
                S.scoreTargets = Array.isArray(r.data.scoreTargets) ? r.data.scoreTargets : S.scoreTargets;
                S.scoreTargetError = r.data.scoreTargetError || null;
            }
            renderHole();
            toast('Pairs saved');
        }
        async function removeFromRound(p) {
            const confirmed = await dialogs.confirm({
                cancelText: 'Cancel',
                confirmText: p.isMe ? 'Leave round' : 'Remove player',
                danger: true,
                message: 'Scores for this player will be cleared.',
                title: p.isMe ? 'Leave this round?' : ('Remove ' + p.name + '?')
            });
            if (!confirmed) return;
            const r = await api('/rounds/' + ROUND_CODE + '/remove', { method: 'POST', body: { index: p.index, name: p.name } });
            closeManagePlayers();
            if (r.status === 409 && r.data && r.data.error === 'player_moved') { await loadMine(); toast('Card changed — open Manage again'); return; }
            if (!r.ok || !r.data) { toast('Could not remove player'); return; }
            if (r.data.cardId == null) { location.href = location.pathname; return; } // I left the round → back to home
            S.cardId = r.data.cardId; S.myIndex = r.data.playerIndex; S.cardmates = Array.isArray(r.data.cardmates) ? r.data.cardmates : S.cardmates;
            renderHole();
            toast(p.name + ' removed');
        }
        function shareRound() {
            const url = location.origin + location.pathname + '?round=' + ROUND_CODE;
            if (navigator.share) { navigator.share({ title: 'GVDG round ' + ROUND_CODE, text: 'Join my disc golf card — code ' + ROUND_CODE, url: url }).catch(function () {}); }
            else if (navigator.clipboard) { navigator.clipboard.writeText(url).then(function () { toast('Link copied'); }).catch(function () { toast('Code: ' + ROUND_CODE); }); }
            else toast('Code: ' + ROUND_CODE);
        }
        function watchHref() {
            return liveWatchHref({ eventId: EVENT_ID, roundCode: ROUND_CODE });
        }
        function shareWatchLink() {
            const path = watchHref();
            if (!path) { toast('Nothing to watch yet'); return; }
            const url = location.origin + location.pathname.replace(/[^/]+$/, '') + path;
            if (navigator.clipboard) { navigator.clipboard.writeText(url).then(function () { toast('Watch link copied'); }).catch(function () { toast(url); }); }
            else toast(url);
        }
        function renderWatch() {
            const snap = S.snap || {};
            const pots = buildLivePots({ acePot: S.pots && S.pots.acePot, ctps: S.pots && S.pots.ctps, roundStatus: S.status });
            setShellHeader({
                showLeaderboard: false,
                subtitle: [S.courseName, S.layoutName].filter(Boolean).join(' · ') || 'Live scoring',
                title: S.status === 'final' ? 'Final' : 'Watch live',
            });
            renderScoreBody('watch', {
                connection: S.status === 'final' ? 'Final' : 'Live',
                courseName: S.courseName,
                holes: watchHoleViews(),
                isDoubles: isDoublesScoring(S),
                isMatchplay: isMatchplayScoring(S),
                keepScoreHref: liveScoreHref({ eventId: EVENT_ID, roundCode: ROUND_CODE, guestToken: GUEST_TOKEN }),
                layoutName: S.layoutName,
                onCopyLink: shareWatchLink,
                pots,
                relClass: relClass,
                relText: relText,
                showPots: pots.visible,
                showWeather: Boolean(S.weather),
                standings: Array.isArray(snap.standings) ? snap.standings : [],
                status: S.status,
                udiscCourseId: S.udiscCourseId || '',
                weather: S.weather,
                windFromDeg: S.weather && S.weather.current ? S.weather.current.windDirectionDeg : null,
                playerLocations: S.playerLocations || [],
                players: Array.isArray(snap.players) ? snap.players : [],
                scoreTargets: Array.isArray(snap.scoreTargets) ? snap.scoreTargets : S.scoreTargets || [],
                activeHoleIndex: fieldActiveHoleIndex({
                    holes: S.holes,
                    players: Array.isArray(snap.players) ? snap.players : [],
                }),
            });
        }
        async function loadWatch() {
            const r = await api(LIVE, { auth: false, guest: false });
            if (!r.ok || !r.data) { renderMessage('Couldn’t load live scores', 'Check the link and try again.', true); return; }
            const d = r.data;
            if (d.status !== 'live' && d.status !== 'final') {
                renderMessage('This round is not live', 'Ask for a live watch link, or open the event page.', true);
                return;
            }
            S.snap = d;
            S.status = d.status || null;
            S.holes = Array.isArray(d.holes) ? d.holes : [];
            S.roundConfig = d.roundConfig || null;
            S.courseName = d.courseName || null;
            S.layoutName = d.layoutName || null;
            S.udiscCourseId = d.udiscCourseId || null;
            S.weather = d.weather || null;
            S.playerLocations = Array.isArray(d.playerLocations) ? d.playerLocations : [];
            S.lastRev = d.rev == null ? -1 : d.rev;
            renderWatch();
            startPotsPolling();
            if (d.status === 'live') connectWs();
        }
        function watchRoundCode(value) {
            const code = cleanRoundCode(value);
            if (code.length >= 4) location.search = '?round=' + code + '&watch=1';
            else toast('Enter a valid code');
        }

        async function boot() {
            setOnline(navigator.onLine);
            if (WATCH && (EVENT_ID || ROUND_CODE)) {
                renderLoading();
                await loadWatch();
                return;
            }
            if (MODE === 'home') { if (!memberToken()) { renderLogin(); return; } renderHome(); return; }
            if (!memberToken() && !GUEST_TOKEN) { renderLogin(); return; }
            renderLoading();
            await loadMine();
        }
        boot();
}
