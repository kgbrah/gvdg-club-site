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
    isPuttingScoring,
    nextHoleScore,
    nextPuttingScore,
    playOrderStep,
    relClass,
    relText,
    optimisticScores,
    scoreForPlayerIndexes,
    scorePendingKey,
    scoreRows,
    throwsByScorer,
    scorecardChoices,
    startingHoleForState,
    strokesForRow,
    udiscExportData,
} from "./score-view-model.js";
import { layoutHoles, matchCourseByName, rememberLastCourse, sortLayoutsForPick } from "./course-pick.js";
import { fillMissingHolePins, holesFromPositionLabels, markerHasPin } from "../shared/hole-pins.js";
import { decorateStandings, handicapScoringEnabled } from "../shared/handicap.js";
import { resolveApiBase } from "../shared/api-base.js";
import { clearMemberSession, readMemberToken, writeMemberSession } from "../shared/member-session.js";
import { createWakeLock } from "../shared/wake-lock.js";
import { isTransientMineFailure, readMineCache, secureMineCacheKey, writeMineCache } from "./score-session-cache.js";
import { OFFLINE_ID } from "../shared/offline-round.js";
import { readOpenPlayName, readOpenPlayToken, writeOpenPlaySession } from "./open-play-session.js";
import { buildLivePots, withLiveCtpLeaders } from "../shared/live-pots-model.js";
import { isLiveWatchRequest, liveRoundCodeFromSearch, liveWatchHref } from "../shared/live-watch.js";
import { scorerSocketProtocols, spectatorHeaders, spectatorSocketProtocols, watchKeyFromLocation, watchUrl } from "../shared/spectator-link.js";
import { createSpectatorTransport } from "./spectator-transport.js";
import { casualReplaySnapshot, watchableLiveSnapshot } from "../shared/casual-replay.js";
import { holeWinners, winnerColor } from "../shared/matchplay-colors.js";
import { GPS_WATCH_OPTIONS, gpsErrorPolicy } from "../shared/hole-map-model.js";
import { createRoundJournal, drainRoundJournal, recoveryResult, resetJournalRetries, roundRecoveryScope } from "./round-recovery.js";
import {
    fieldLiveUpdate, fieldLog, fieldMark, fieldRedactNames, fieldSince, fieldTestOn, fieldTrackClip, fieldWatchSocket,
} from "../shared/field-test-gate.js";
import { parseShotRows, shotPoint } from "../shared/shot-ledger.js";
import { shotLedgerState, statsFromShotLedgers } from "./shot-ledger-model.js";
import { decodeJwtPayload, notifyScoreAuthChanged } from "../shared/player-theme-session.js";
import {
    buildShareCard,
    canShareFiles,
    downloadShareFile,
    shareCardFile,
    shareCardPng,
    shareCardText,
} from "./scorecard-share.js";

export function startScoreApp(options) {
        "use strict";
        options = options || {};
        const API_BASE = resolveApiBase({ datasetKeys: ['apiBase'] });

        const GUESTREG_KEY = 'gvdg_guest_regs', RECENT_ROUNDS_KEY = 'gvdg_recent_rounds';
        const params = new URLSearchParams(location.search);
        const EVENT_ID = (params.get('event') || '').replace(/[^0-9]/g, '');
        const ROUND_CODE = liveRoundCodeFromSearch(params);
        const MODE = ROUND_CODE ? 'round' : (EVENT_ID ? 'event' : 'home'); // event scoring · casual round · home
        const offlineReturn = MODE === 'home' && OFFLINE_ID.test(params.get('returnToOffline') || '') ? params.get('returnToOffline') : null;
        const COURSE_QUERY = MODE === 'home' ? String(params.get('course') || '').trim() : '';
        const WATCH = isLiveWatchRequest(params);
        const WATCH_KEY = WATCH && !EVENT_ID ? watchKeyFromLocation(location) : null;
        const LIVE = WATCH_KEY ? '/watch-round' : ROUND_CODE ? ('/rounds/' + ROUND_CODE + '/live') : ('/events/' + EVENT_ID + '/live');
        // A guest scores an EVENT via their registration token (URL ?gt= or saved at registration).
        // Casual rounds accept a member session OR an open-play scoring token (no club PIN).
        function guestTokenStored() { try { const a = JSON.parse(localStorage.getItem(GUESTREG_KEY) || '{}'); return (a[EVENT_ID] && a[EVENT_ID].guestToken) || null; } catch (e) { return null; } }
        const GUEST_TOKEN = MODE === 'event' ? (params.get('gt') || guestTokenStored()) : null;

        const dialogs = createScoreDialogRenderer();
        const notifications = createScoreNotificationsRenderer();
        const scoreBody = options && options.body;
        const scoreShell = options && options.shell;
        const POTS_REFRESH_MS = 30 * 1000;
        const S = { holes: [], cardId: null, myIndex: null, scorerIndex: null, cardmates: [], joinRequests: [], snap: null, holeIdx: 0, ws: null, wsTimer: null, status: null, conflicts: [], missing: [], courseName: null, layoutName: null, lastRev: -1, udiscCourseId: null, roundConfig: null, scoreTargets: [], scoreTargetError: null, weather: null, pots: null, playerLocations: [], cardLocked: false, cardAttestation: { agreedIndexes: [], neededIndexes: [], complete: false }, finishConfirmOpen: false, handicaps: null, handicapLayoutId: null, handicapLoading: false, handicapTicket: 0 };
        let potsTimer = null;
        let spectator = null;
        let watchState = { phase: "connecting", snapshot: null };
        let locWatchId = null;
        let locRetryTimer = null;
        let locLastSent = 0;
        let locLastFix = null;
        let locLifecycleBound = false;
        let catalogPinsFor = null;
        let recovery = null;
        let recoveryTimer = null;
        let recoveryRun = null;
        let recoveryWake = null;
        let mineRequest = 0;
        let finishing = false;
        const wakeLock = createWakeLock();

        // ---------- tiny helpers ----------
        function memberToken() { return readMemberToken() || null; }
        let phoneActivitySession = null;
        function phoneActivityApi() {
            const token = memberToken();
            if (!token) { phoneActivitySession = null; return null; }
            if (phoneActivitySession?.token !== token) {
                const credential = { type: 'bearer', token };
                phoneActivitySession = { token, request: (path, options = {}) => api(path, { ...options, guest: false, credential }) };
            }
            return phoneActivitySession.request;
        }
        function scoringCredential() {
            const member = memberToken();
            if (member) return { type: 'bearer', token: member };
            const token = MODE === 'event' ? GUEST_TOKEN : readOpenPlayToken();
            return { type: MODE === 'event' ? 'guest' : 'bearer', token };
        }
        function scoringToken() { return scoringCredential().token; }
        function sameCredential(credential) {
            const current = scoringCredential();
            return Boolean(credential && credential.token && credential.type === current.type && credential.token === current.token);
        }
        function hasScoringIdentity() { return !!(memberToken() || readOpenPlayToken()); }
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
        function forgetRecentRound(code) {
            try {
                const key = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
                if (!key) return false;
                const rows = JSON.parse(localStorage.getItem(RECENT_ROUNDS_KEY) || '[]');
                const list = Array.isArray(rows) ? rows : [];
                const next = list.filter(function (row) {
                    return String(row && row.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') !== key;
                });
                if (next.length === list.length) return false;
                localStorage.setItem(RECENT_ROUNDS_KEY, JSON.stringify(next));
                return true;
            } catch (e) { return false; }
        }
        let pruningRecent = false;
        async function stillOnRecentRound(code) {
            const live = await api('/rounds/' + code + '/live', { guest: false });
            if (live.neterr) return true;
            if (live.status === 404) return false;
            if (!live.ok || !live.data) return true;
            if (live.data.status !== 'live') return false;
            if (!scoringToken()) return true;
            const mine = await api('/rounds/' + code + '/live/mine');
            if (mine.neterr || mine.status === 401 || mine.status === 403) return true;
            if (mine.status === 404) return false;
            if (!mine.ok || !mine.data) return true;
            if (mine.data.status !== 'live') return false;
            return mine.data.cardId != null && Array.isArray(mine.data.cardmates) && mine.data.cardmates.length > 0;
        }
        async function pruneLeftRounds() {
            if (pruningRecent) return false;
            pruningRecent = true;
            try {
                const rows = JSON.parse(localStorage.getItem(RECENT_ROUNDS_KEY) || '[]');
                const list = Array.isArray(rows) ? rows : [];
                const checks = await Promise.all(list.map(async function (row) {
                    const code = String(row && row.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
                    if (!code) return false;
                    try { return await stillOnRecentRound(code); }
                    catch (e) { return true; }
                }));
                let changed = false;
                list.forEach(function (row, index) {
                    if (checks[index]) return;
                    if (forgetRecentRound(row && row.code)) changed = true;
                });
                return changed;
            } catch (e) {
                return false;
            } finally {
                pruningRecent = false;
            }
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
        async function api(path, opts = {}) {
            const headers = { ...opts.headers };
            let url = path;
            const credential = opts.credential || scoringCredential();
            const token = opts.auth !== false && credential.type === 'bearer' ? credential.token : null;
            const guest = opts.guest !== false && credential.type === 'guest' ? credential.token : null;
            if (token) headers.Authorization = 'Bearer ' + token;
            if (guest) url += (url.includes('?') ? '&' : '?') + 'gt=' + encodeURIComponent(guest);
            let body = opts.body;
            if (body !== undefined && !opts.raw) {
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify(guest ? { guestToken: guest, ...body } : body);
            }
            const abort = opts.timeout ? new AbortController() : null;
            const timer = abort ? setTimeout(() => abort.abort(), opts.timeout) : null;
            try {
                const response = await fetch(API_BASE + url, { method: opts.method || 'GET', headers, body, cache: 'no-store', signal: abort?.signal });
                const data = await response.json().catch(() => null);
                return { ok: response.ok, status: response.status, data, retryAfter: response.headers.get('Retry-After') };
            } catch {
                return { ok: false, status: 0, data: null, neterr: true };
            } finally {
                clearTimeout(timer);
            }
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
            if (locRetryTimer != null) {
                clearTimeout(locRetryTimer);
                locRetryTimer = null;
            }
        }
        function postLiveLocation(lat, lng, force) {
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            locLastFix = { lat: lat, lng: lng };
            const now = Date.now();
            if (!force && now - locLastSent < 8000) return;
            locLastSent = now;
            void api(LIVE + '/location', { method: 'POST', body: { lat: lat, lng: lng } }).then(function (r) {
                if (r.status === 401 || r.status === 403 || r.status === 409) stopLiveLocation();
            });
        }
        function onLiveLocationResume() {
            if (WATCH) return;
            if (S.status === 'final') return;
            startLiveLocation();
        }
        function onLiveLocationVisibility() {
            if (document.visibilityState === 'visible') {
                onLiveLocationResume();
                return;
            }
            if (locLastFix) postLiveLocation(locLastFix.lat, locLastFix.lng, true);
        }
        function bindLiveLocationLifecycle() {
            if (WATCH || locLifecycleBound) return;
            locLifecycleBound = true;
            document.addEventListener('visibilitychange', onLiveLocationVisibility);
            window.addEventListener('pageshow', onLiveLocationResume);
            window.addEventListener('online', onLiveLocationResume);
        }
        function startLiveLocation() {
            if (WATCH) return;
            if (!memberToken()) return;
            if (!navigator.geolocation) return;
            bindLiveLocationLifecycle();
            if (locRetryTimer != null) {
                clearTimeout(locRetryTimer);
                locRetryTimer = null;
            }
            if (locWatchId != null && navigator.geolocation) {
                try { navigator.geolocation.clearWatch(locWatchId); } catch (e) {}
                locWatchId = null;
            }
            locWatchId = navigator.geolocation.watchPosition(function (pos) {
                const lat = pos.coords && pos.coords.latitude;
                const lng = pos.coords && pos.coords.longitude;
                postLiveLocation(lat, lng, false);
            }, function (err) {
                const policy = gpsErrorPolicy(err && err.code, true);
                if (!policy.restart) {
                    stopLiveLocation();
                    return;
                }
                locRetryTimer = setTimeout(function () {
                    locRetryTimer = null;
                    startLiveLocation();
                }, policy.retryMs);
            }, GPS_WATCH_OPTIONS);
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
            const baseline = snap && snap.ratingBaseline;
            const baselineChanged = Boolean(baseline && Number.isFinite(baseline.ssa) && Number.isFinite(baseline.ppt)
                && (!S.ratingBaseline || S.ratingBaseline.ssa !== baseline.ssa || S.ratingBaseline.ppt !== baseline.ppt));
            if (baselineChanged) S.ratingBaseline = { ssa: baseline.ssa, ppt: baseline.ppt };
            return weatherChanged || locationsChanged || baselineChanged;
        }

        // ---------- durable card recovery ----------
        function isCurrentRecovery(context) {
            return Boolean(context && context === recovery && sameCredential(context.credential));
        }
        function readRecovery(context = recovery) {
            S.recoveryStorageError = false;
            try { S.recoveryItems = context ? context.journal.entries() : []; }
            catch {
                S.recoveryItems = [];
                S.recoveryStorageError = true;
            }
            S.optimisticScores = optimisticScores(S.recoveryItems);
        }
        function stopRecovery() {
            clearTimeout(recoveryTimer);
            recoveryTimer = null;
            recoveryWake = null;
            recovery = null;
            S.lastSavedLie = null;
            S.shotLedgers = {};
            if (S.ws) { const ws = S.ws; S.ws = null; ws.close(); }
            clearTimeout(S.wsTimer);
            S.wsTimer = null;
        }
        function bindRecovery(scope, credential, cacheKey) {
            if (scope && isCurrentRecovery(recovery) && recovery.scope.key === scope.key) {
                readRecovery();
                return;
            }
            stopRecovery();
            if (scope) {
                let storage = null;
                try { storage = window.localStorage; } catch { /* availability is surfaced by readRecovery */ }
                const context = { scope, credential, cacheKey, journal: createRoundJournal(storage, scope) };
                context.uploadClip = function (record) {
                    if (!isCurrentRecovery(context)) return null;
                    const query = new URLSearchParams({
                        hole: record.hole, playerIndex: record.playerIndex, playerName: record.playerName,
                        highlight: record.highlight ? '1' : '0', moment: record.moment || '',
                        clientId: record.id, recoveryRoundId: scope.roundId, recoveryCardId: scope.cardId,
                        recoveryActorIndex: scope.actorIndex,
                    });
                    const sent = api(LIVE + '/clips?' + query, {
                        method: 'POST', credential, guest: false, raw: true, body: record.blob, timeout: 120000,
                        headers: {
                            'Content-Type': record.blob.type || 'application/octet-stream',
                            ...(credential.type === 'guest' ? { Authorization: 'Guest ' + credential.token } : {}),
                        },
                    });
                    return fieldTestOn() ? fieldTrackClip(sent, record, 'live') : sent;
                };
                recovery = context;
            }
            readRecovery();
        }
        async function enqueueRecovery(kind, prepare) {
            const context = recovery;
            if (!isCurrentRecovery(context)) { toast('Open your card online to enable recovery'); return; }
            const perform = () => {
                if (!isCurrentRecovery(context)) return false;
                if (finishing || S.cardLocked || S.status !== 'live' || context.journal.isSubmitted()) {
                    toast('This card is already being submitted or locked');
                    return false;
                }
                readRecovery(context);
                const edit = prepare();
                if (!edit) return false;
                const item = context.journal.enqueue(kind, edit.body, edit.previous);
                if (fieldTestOn()) fieldQueued(context, item);
                readRecovery(context);
                return true;
            };
            try {
                const added = navigator.locks && navigator.locks.request
                    ? await navigator.locks.request(context.journal.writeLockName, (lock) => lock && perform())
                    : perform();
                if (!added) return;
            } catch {
                const editLabel = kind === 'score' ? 'Score' : kind === 'shots' ? 'Shot' : 'Lie';
                toast(editLabel + ' not saved. Free space on this phone and try again.');
                return false;
            }
            renderHole();
            void flushRecovery();
            return true;
        }
        function scheduleRecovery(context, at) {
            if (!at || !isCurrentRecovery(context)) return;
            if (recoveryTimer) clearTimeout(recoveryTimer);
            recoveryTimer = setTimeout(() => {
                recoveryTimer = null;
                void flushRecovery();
            }, Math.max(100, at - Date.now()));
        }
        async function flushRecovery(wake) {
            const context = recovery;
            if (!isCurrentRecovery(context) || finishing) return;
            if (!navigator.onLine) { if (wake === 'manual') toast('Connect to the internet to sync the card'); return; }
            if (wake) recoveryWake = { context, includeErrors: wake === 'manual' || Boolean(recoveryWake?.includeErrors) };
            if (recoveryRun) return recoveryRun;
            clearTimeout(recoveryTimer);
            recoveryTimer = null;
            const perform = async () => {
                if (!isCurrentRecovery(context)) return;
                if (recoveryWake && recoveryWake.context === context) {
                    resetJournalRetries(context.journal, { includeErrors: recoveryWake.includeErrors });
                    recoveryWake = null;
                    readRecovery(context);
                    renderHole();
                }
                const at = await drainRoundJournal(context.journal, (item) => {
                    if (!isCurrentRecovery(context)) return null;
                    const { roundId, cardId, actorIndex } = context.scope;
                    const body = { ...item.body, recovery: { roundId, cardId, actorIndex, order: item.order, stream: item.stream, previous: item.previous } };
                    const action = item.kind === 'shots' ? 'throws' : item.kind;
                    const sent = api(LIVE + '/' + action, { method: 'POST', body, credential: context.credential, timeout: 12000 });
                    if (!fieldTestOn()) return sent;
                    const mark = fieldMark();
                    return sent.then((result) => { fieldAck(context, item, result, fieldSince(mark)); return result; });
                }, {
                    active: () => isCurrentRecovery(context) && !finishing,
                    online: () => navigator.onLine,
                    onResult: (item, state, result) => {
                        if (!isCurrentRecovery(context)) return;
                        readRecovery(context);
                        if (item.kind === 'shots' && result.data?.ledger) {
                            mergeShotLedgerCell(item.body.scorerIndex, item.body.hole, result.data.ledger);
                            persistMineCache();
                        }
                        if (state === 'saved') {
                            if (item.kind === 'throws') S.lastSavedLie = { hole: item.body.hole, scorerIndex: item.body.scorerIndex };
                            const snap = item.kind === 'score' ? result.data : result.data && result.data.snapshot;
                            if (snap && snap.recoveryRoundId === context.scope.roundId && (snap.rev == null || snap.rev > S.lastRev)) {
                                S.snap = snap;
                                mergeFromSnap();
                            }
                        }
                        renderHole();
                    },
                });
                scheduleRecovery(context, at);
            };
            recoveryRun = (async () => {
                try {
                    if (navigator.locks && navigator.locks.request) {
                        await navigator.locks.request(context.journal.lockName, { ifAvailable: true }, (lock) => {
                            if (!lock) { scheduleRecovery(context, Date.now() + 700); return; }
                            return perform();
                        });
                    } else await perform();
                } catch {
                    if (isCurrentRecovery(context)) {
                        S.recoveryStorageError = true;
                        renderHole();
                        scheduleRecovery(context, Date.now() + 5000);
                    }
                }
            })();
            try { await recoveryRun; }
            finally {
                recoveryRun = null;
                if ((recoveryWake && !recoveryTimer) || (recovery && recovery !== context)) void flushRecovery();
            }
        }
        async function discardRecovery(id) {
            const context = recovery;
            if (!isCurrentRecovery(context)) return;
            const perform = () => {
                if (!isCurrentRecovery(context)) return;
                const item = context.journal.entries().find((row) => row.id === id && (row.state === 'error' || row.state === 'auth'));
                if (item) {
                    context.journal.remove(item);
                    fieldLog('sync.discard', { id: item.id, kind: item.kind, hole: item.body?.hole ?? null, roundId: context.scope.roundId });
                }
                readRecovery(context);
                renderHole();
            };
            try {
                if (navigator.locks && navigator.locks.request) await navigator.locks.request(context.journal.lockName, perform);
                else { await recoveryRun; perform(); }
            } catch { toast('Could not update the saved changes on this phone'); }
            void flushRecovery();
        }

        function setOnline(on) { notifications.setOnline(on); }

        // ---------- field test mode (no-ops unless a volunteer turned it on) ----------
        function fieldQueueLength(context) {
            try { return context.journal.entries().length; } catch { return null; }
        }
        function fieldScoreKey(body) {
            if (body && body.targetId) return 't:' + body.targetId;
            return body && Number.isInteger(body.index) ? 'i:' + body.index : null;
        }
        function fieldQueued(context, item) {
            const body = (item && item.body) || {};
            fieldLog('sync.queue', {
                id: item.id, kind: item.kind, hole: body.hole ?? null, roundId: context.scope.roundId,
                ...(item.kind === 'score' ? { key: fieldScoreKey(body), strokes: body.strokes ?? null, scorer: body.scorerIndex ?? null } : {}),
                queue: fieldQueueLength(context),
            });
        }
        function fieldAck(context, item, result, ms) {
            const queuedAt = Number(String(item.order || '').split(':')[0]);
            fieldLog('sync.ack', {
                id: item.id, kind: item.kind, hole: item.body?.hole ?? null, roundId: context.scope.roundId, ms,
                queuedMs: Number.isFinite(queuedAt) && queuedAt > 0 ? Math.max(0, Date.now() - queuedAt) : null,
                status: result?.status ?? null, state: recoveryResult(result), attempt: item.attempt || 0,
                error: result?.data?.error || null, queue: fieldQueueLength(context),
            });
        }
        const fieldChecked = new Set();
        // Once the card is locked or the round is final, compare this phone's entries with the server's card.
        function fieldFinalCheck() {
            if (!fieldTestOn() || !isCurrentRecovery(recovery)) return;
            const reason = S.status === 'final' ? 'final' : S.cardLocked ? 'locked' : null;
            if (!reason) return;
            const key = recovery.scope.roundId + ':' + reason;
            if (fieldChecked.has(key)) return;
            fieldChecked.add(key);
            const players = Array.isArray(S.snap?.players) && S.snap.players.length ? S.snap.players : S.cardmates;
            const holes = (S.holes || []).map((hole) => hole.hole);
            const rows = scoreRows(S).map((row) => ({
                key: row.targetId ? 't:' + row.targetId : 'i:' + row.index,
                holes: Object.fromEntries(holes.map((hole) => [hole, scoreForPlayerIndexes(players, row.playerIndexes, hole)])),
            }));
            fieldLog('round.server', { roundId: recovery.scope.roundId, reason, status: S.status, rows });
        }
        function fieldRoundNames(d) {
            const people = [].concat(Array.isArray(d?.players) ? d.players : [], Array.isArray(d?.cardmates) ? d.cardmates : []);
            const targets = Array.isArray(d?.scoreTargets) ? d.scoreTargets : [];
            return people.map((row) => row && row.name)
                .concat(targets.flatMap((target) => [target && target.label].concat(Array.isArray(target?.members) ? target.members : [])));
        }
        window.addEventListener('online', function () {
            setOnline(true);
            void flushRecovery('online');
            if (WATCH) spectator?.resume();
            else if (isCurrentRecovery(recovery)) connectWs();
        });
        window.addEventListener('offline', function () { setOnline(false); spectator?.offline(); });
        window.addEventListener('pageshow', function () { spectator?.resume(); });
        window.addEventListener('storage', function (event) {
            if (WATCH && !WATCH_KEY && ROUND_CODE && ['gvdg_member_token', 'gvdg_open_play_token'].includes(event.key)) spectator?.checkIdentity();
            const context = recovery;
            if (!context) return;
            if (!isCurrentRecovery(context)) { void boot(); return; }
            if (context.journal.hasStorageKey(event.key)) { readRecovery(context); renderHole(); void flushRecovery(); }
        });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) { spectator?.resume(); void flushRecovery(); }
        });

        // ---------- score state access ----------
        function currentScorerIndex() {
            const choices = scorecardChoices(S);
            if (!choices.length) return null;
            if (choices.some((p) => p.index === S.scorerIndex)) return S.scorerIndex;
            const mine = choices.find((p) => p.index === S.myIndex);
            S.scorerIndex = (mine || choices[0]).index;
            return S.scorerIndex;
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

        function postThrows(hole, edit, scorerIndex) {
            if (scorerIndex == null || scorerIndex !== currentScorerIndex()) return;
            void enqueueRecovery('throws', () => {
                const previous = throwsByScorer(S, scorerIndex)[hole] || [];
                const throws = edit(previous).map((point) => ({ lat: Number(point.lat.toFixed(5)), lng: Number(point.lng.toFixed(5)), n: point.n }));
                if (throws.length === previous.length) return null;
                if (throws.length > 18) { toast('This hole already has 18 marked lies'); return null; }
                const discColor = document.documentElement?.getAttribute('data-disc-color');
                const body = { hole, throws, scorerIndex, ...(discColor ? { discColor } : {}) };
                return { body, previous };
            });
        }
        function mergeShotLedgerCell(scorerIndex, hole, ledger) {
            const ledgers = S.shotLedgers || (S.shotLedgers = {});
            const book = ledgers[scorerIndex] || (ledgers[scorerIndex] = {});
            if (ledger.version >= (book[hole]?.version ?? 0)) book[hole] = ledger;
        }
        function mergePrivateShotLedgers(ledgers) {
            for (const [scorer, book] of Object.entries(ledgers || {})) {
                for (const [hole, ledger] of Object.entries(book)) mergeShotLedgerCell(scorer, hole, ledger);
            }
        }
        async function refreshShotLedgers() {
            const context = recovery;
            if (!isCurrentRecovery(context) || !navigator.onLine) return;
            const result = await api(LIVE + '/mine', { credential: context.credential, timeout: 12000 });
            if (!isCurrentRecovery(context) || !result.ok || result.data?.recoveryRoundId !== context.scope.roundId ||
                result.data?.playerIndex !== context.scope.actorIndex || result.data?.cardId !== context.scope.cardId) return;
            mergePrivateShotLedgers(result.data.shotLedgers);
            persistMineCache();
            renderHole();
        }
        async function postShots(hole, scorerIndex, model, next) {
            const rows = parseShotRows(next);
            if (!rows) { toast('Check the shot details and try again'); return false; }
            return enqueueRecovery('shots', () => {
                if (scorerIndex !== currentScorerIndex() || !S.holes.some((row) => row.hole === hole.hole)) return null;
                const current = shotLedgerState(S, scorerIndex, hole);
                if (!current || current.revision !== model.revision || current.target.id !== model.target.id ||
                    current.target.binding !== model.target.binding) {
                    toast('These shots changed. Review the current ledger before saving.');
                    return null;
                }
                return {
                    body: { hole: hole.hole, scorerIndex, ledger: { targetId: model.target.id, binding: model.target.binding, rows,
                        geometry: { tee: shotPoint(model.geometry.tee), target: shotPoint(model.geometry.target) } } },
                    previous: model.revision,
                };
            });
        }
        function patchHoleMarker(hole, kind, point) {
            const row = (S.holes || []).find(function (h) { return h && h.hole === hole; });
            if (!row || !point) return;
            const label = kind === 'tee'
                ? ((row.tee && row.tee.label) || 'Tee')
                : ((row.target && row.target.label) || 'Basket');
            const marker = { label: label, lat: point.lat, lng: point.lng };
            if (kind === 'tee') row.tee = marker;
            else row.target = marker;
        }
        function postMapMark(kind, hole, fix, reason) {
            if (reason === 'gps_inaccurate') { toast('GPS is too fuzzy — wait for a better fix'); return; }
            if (!memberToken()) { toast('Sign in to help map this course'); return; }
            if (S.status === 'final') { toast('This round is already final'); return; }
            const lat = fix && fix.lat;
            const lng = fix && fix.lng;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) { toast('Need GPS to mark that'); return; }
            const body = { hole: hole, kind: kind, lat: lat, lng: lng };
            if (Number.isFinite(fix.accuracyM)) body.accuracyM = fix.accuracyM;
            void api(LIVE + '/map-mark', { method: 'POST', body: body }).then(function (r) {
                if (r.ok && r.data) {
                    patchHoleMarker(hole, kind, r.data.consensus || r.data.point);
                    if (r.data.published) toast(kind === 'tee' ? 'Tee pad published on the club map' : 'Basket published on the club map');
                    else toast((kind === 'tee' ? 'Tee pad saved' : 'Basket saved') + ' · ' + String(r.data.members || 1) + ' mark' + (r.data.members === 1 ? '' : 's'));
                    renderHole();
                    return;
                }
                if (r.status === 401 || r.status === 403) toast('Sign in to help map this course');
                else if (r.data && r.data.error === 'gps_inaccurate') toast('GPS is too fuzzy — wait for a better fix');
                else if (r.data && r.data.error === 'too_far') toast('That mark is too far from this hole');
                else if (r.data && r.data.error === 'off_course') toast('That GPS point is off this course');
                else if (r.data && r.data.error === 'rate_limited') toast('Slow down a second');
                else toast('Could not save that map mark');
            });
        }
        function postScore(row, hole, strokes, viewScorer, step) {
            const scorerIndex = currentScorerIndex();
            if (viewScorer !== undefined && viewScorer !== scorerIndex) return;
            if (scorerIndex == null) { toast('Choose a scorecard'); return; }
            void enqueueRecovery('score', () => {
                const key = scorePendingKey(scorerIndex, row.index, hole, row.targetId);
                const player = S.cardmates.find((mate) => mate.index === row.playerIndexes?.[0]);
                const previous = S.optimisticScores.has(key) ? S.optimisticScores.get(key) : player?.scorecards?.[hole]?.['player:' + scorerIndex] ?? null;
                let value = strokes;
                if (step === "plus" || step === "minus") {
                    const current = strokesForRow(S, row, hole, scorerIndex);
                    const par = S.holes.find((entry) => entry.hole === hole)?.par;
                    value = (isPuttingScoring(S) ? nextPuttingScore : nextHoleScore)(current, par, step);
                }
                const body = { scorerIndex, hole, strokes: value };
                if (row.targetId) body.targetId = row.targetId;
                else body.index = row.index;
                return { body, previous };
            });
        }

        // ---------- merge a snapshot's authoritative scores into our cardmates ----------
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
        function rememberHolePins(holes) {
            if (!S.holePins) S.holePins = {};
            (Array.isArray(holes) ? holes : []).forEach((hole) => {
                const n = Number(hole && hole.hole);
                if (!Number.isInteger(n) || n < 1) return;
                const prev = S.holePins[n] || { hole: n, tee: null, target: null };
                const next = { hole: n, tee: prev.tee || null, target: prev.target || null };
                if (markerHasPin(hole.tee)) next.tee = { label: hole.tee.label || null, lat: Number(hole.tee.lat), lng: Number(hole.tee.lng) };
                if (markerHasPin(hole.target)) next.target = { label: hole.target.label || null, lat: Number(hole.target.lat), lng: Number(hole.target.lng) };
                S.holePins[n] = next;
            });
        }
        function holesNeedPins(holes) {
            return (Array.isArray(holes) ? holes : []).some((hole) => !markerHasPin(hole && hole.tee) || !markerHasPin(hole && hole.target));
        }
        function pinSignature(holes) {
            return (Array.isArray(holes) ? holes : []).map((hole) => {
                const tee = (hole && hole.tee) || {};
                const basket = (hole && hole.target) || {};
                return [hole && hole.hole, tee.lat, tee.lng, basket.lat, basket.lng].join(",");
            }).join("|");
        }
        function noteCourse(source) {
            if (!source) return;
            if (source.courseId) S.courseId = source.courseId;
            if (source.layoutId) S.layoutId = source.layoutId;
        }
        function assignHoles(holes, source) {
            noteCourse(source);
            const list = Array.isArray(holes) ? holes : [];
            rememberHolePins(list);
            S.holes = fillMissingHolePins(list, [Object.values(S.holePins || {})]);
            if (holesNeedPins(S.holes)) void ensureCatalogPins();
        }
        async function ensureCatalogPins() {
            const courseId = Number(S.courseId);
            if (!Number.isInteger(courseId) || courseId <= 0) return;
            if (!holesNeedPins(S.holes)) return;
            if (catalogPinsFor === courseId) return;
            catalogPinsFor = courseId;
            const [layoutRes, posRes] = await Promise.all([
                api("/courses/" + courseId + "/layouts", { auth: false, guest: false }),
                api("/courses/" + courseId + "/positions", { auth: false, guest: false }),
            ]);
            if (layoutRes.status === 0 && posRes.status === 0) {
                catalogPinsFor = null;
                return;
            }
            const positions = posRes.ok && posRes.data && Array.isArray(posRes.data.positions) ? posRes.data.positions : [];
            rememberHolePins(holesFromPositionLabels(positions));
            const layouts = layoutRes.ok && layoutRes.data && Array.isArray(layoutRes.data.layouts) ? layoutRes.data.layouts : [];
            const layoutId = Number(S.layoutId);
            const layout = layouts.find((row) => Number(row && row.id) === layoutId) || null;
            if (layout) rememberHolePins(layoutHoles(layout));
            const before = pinSignature(S.holes);
            S.holes = fillMissingHolePins(S.holes, [Object.values(S.holePins || {})]);
            if (pinSignature(S.holes) === before) return;
            if (WATCH) renderWatch();
            else if (S.holes.length) renderHole();
            if (S.cardId) persistMineCache();
        }
        function mergeFromSnap() {
            const snap = S.snap; if (!snap || !Array.isArray(snap.players)) return;
            if (snap.roundConfig) S.roundConfig = snap.roundConfig;
            ensureHandicaps(snap.layoutId || S.layoutId);
            const extrasChanged = applyLiveExtras(snap);
            if (snap.status === 'final') stopLiveLocation();
            // Drop a stale/out-of-order snapshot (a newer one from another device was already applied).
            if (snap.rev != null) { if (snap.rev <= S.lastRev) { if (extrasChanged) renderHole(); return; } S.lastRev = snap.rev; }
            if (snap.status) S.status = snap.status; // reflect a finalize (or start) that happened on another device
            if (Array.isArray(snap.holes) && snap.holes.length) assignHoles(snap.holes, snap);
            if (typeof snap.cardLocked === 'boolean') S.cardLocked = snap.cardLocked;
            else if (Array.isArray(snap.lockedCardIds)) S.cardLocked = snap.lockedCardIds.indexOf(String(S.cardId ?? 'c0')) >= 0;
            if (snap.cardAttestation) S.cardAttestation = snap.cardAttestation;
            else if (snap.cardAttestations && S.cardId != null) {
                const votes = snap.cardAttestations[String(S.cardId ?? 'c0')] || [];
                S.cardAttestation = { agreedIndexes: votes, neededIndexes: (S.cardmates || []).map((row) => row.index), complete: false };
            }
            if (S.cardLocked) S.finishConfirmOpen = false;
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
            if (Array.isArray(snap.joinRequests)) {
                S.joinRequests = snap.joinRequests.filter(function (request) {
                    return request && (request.cardId ?? null) === (S.cardId ?? null);
                });
            }
            S.cardmates.forEach((cm) => {
                const player = byIndex.get(cm.index);
                if (!player) return;
                cm.scores = player.scores || {};
                cm.scorecards = player.scorecards || {};
                if (player.throws) cm.throws = player.throws;
            });
            renderHole();
            if (lbOpen) renderLeaderboard();
            if (managePlayersOpen) renderManagePlayers();
            persistMineCache();
            fieldFinalCheck();
        }

        // ---------- WebSocket live sync ----------
        function connectWs() {
            if (MODE === 'home' || WATCH || !isCurrentRecovery(recovery)) return;
            if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
            let ws;
            try { ws = fieldWatchSocket(new WebSocket(API_BASE.replace(/^http/, 'ws') + LIVE + '/ws', scorerSocketProtocols(scoringCredential())), 'scorer'); }
            catch (e) { return; }
            S.ws = ws;
            ws.addEventListener('message', function (ev) {
                let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
                // Two scorers on the same card disagreed on a hole — alert this card immediately to reconcile.
                if (msg && msg.type === 'conflict') {
                    if (msg.cardId === S.cardId) {
                        fieldLog('sync.conflict', { hole: msg.hole ?? null, source: 'ws' });
                        upsertConflict(msg); conflictAlert(msg); renderHole();
                    }
                    return;
                }
                if (msg && msg.type === 'snapshot') {
                    if (!isCurrentRecovery(recovery)) return;
                    if (msg.recoveryRoundId !== recovery.scope.roundId) { void loadMine(); return; }
                    if (msg.rev != null && msg.rev < S.lastRev) return;
                    fieldLiveUpdate('scorer', msg);
                    S.snap = msg;
                    mergeFromSnap();
                }
            });
            ws.addEventListener('close', function (event) {
                if (S.ws !== ws) return;
                S.ws = null;
                if (event.code === 4403) { void loadMine(); return; }
                if (S.wsTimer) return;
                S.wsTimer = setTimeout(function () { S.wsTimer = null; connectWs(); }, 4000);
            });
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
        function returnAfterLogin() {
            if (offlineReturn) location.replace('score.html?offline=' + offlineReturn);
            else boot();
        }
        function afterAuth(data) {
            writeMemberSession({ token: data.token, name: data.name || undefined });
            notifyScoreAuthChanged();
            if (data.mustChangePin) renderSetPin();
            else returnAfterLogin();
        }
        async function saveNewPin(newPin) {
            const r = await api('/set-pin', { method: 'POST', guest: false, body: { newPin: newPin } });
            if (r.status === 200 && r.data && r.data.token) {
                writeMemberSession({ token: r.data.token });
                notifyScoreAuthChanged();
                returnAfterLogin();
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
            wakeLock.stop();
            const supported = passkeysSupported();
            renderAuthFlow({
                guestAvailable: !!GUEST_TOKEN,
                membersHref: 'gvdg-members.html',
                message: message,
                mode: 'login',
                onGuestContinue: function () { clearMemberSession(); notifyScoreAuthChanged(); boot(); },
                onLogin: loginWithPin,
                onOpenPlay: MODE === 'event' || offlineReturn ? null : function () { renderOpenPlay(); },
                onPasskeyLogin: supported ? loginWithPasskey : null,
                openPlayAvailable: MODE !== 'event' && !offlineReturn,
                passkeysSupported: supported
            });
            if (supported) {
                prefetchPasskey(); // warm the Worker + hold a challenge so the tap has no network before get()
            }
        }
        function renderOpenPlay(after) {
            wakeLock.stop();
            renderAuthFlow({
                defaultName: readOpenPlayName(),
                message: MODE === 'round' ? 'Enter the name that should appear on this card.' : 'Your name on the card. No club PIN needed.',
                mode: 'openPlay',
                onSignIn: function () { renderLogin(); },
                onStart: function (payload) { return startOpenPlay(payload.name, after); }
            });
        }
        async function startOpenPlay(name, after) {
            const r = await api('/rounds/open-play', { method: 'POST', auth: false, guest: false, body: { name: name } });
            if (!r.ok || !r.data || !r.data.token) {
                return { ok: false, message: r.status === 429 ? 'Too many tries — wait a minute and try again.' : 'Could not start a guest card. Check the connection and try again.' };
            }
            writeOpenPlaySession({ token: r.data.token, name: r.data.name || name, offlineToken: r.data.offlineToken });
            if (typeof after === 'function') after();
            else boot();
            return { ok: true };
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
            if (recovery && !isCurrentRecovery(recovery)) return;
            const scorecardState = buildScorecardViewState({
                state: S,
                mode: MODE,
                roundCode: ROUND_CODE,
                scorerIndex: scorerIndex,
                teeSign: liveTeeSignView(h),
            });
            const shotLedger = !scorecardState.putting && scorerIndex === S.myIndex ? shotLedgerState(S, scorerIndex, h) : null;
            const shotStats = !scorecardState.putting ? statsFromShotLedgers(S, S.myIndex, throwsByScorer(S, S.myIndex)) : null;
            const ledgerScore = scorecardState.rows.find((row) => row.source.playerIndexes.includes(scorerIndex));
            renderScoreBody('scorecard', {
                ...scorecardState,
                watchApi: !WATCH && (memberToken() || (ROUND_CODE && readOpenPlayToken())) ? api : null,
                phoneActivityApi: !WATCH ? phoneActivityApi() : null,
                phoneOwnerId: decodeJwtPayload(memberToken())?.sub || null,
                eventId: EVENT_ID,
                onFullScorecard: openLeaderboard,
                onAddPlayer: addGuestPrompt,
                onManagePlayers: openManagePlayers,
                onNext: function () { S.holeIdx = playOrderStep(S.holes, S.holeIdx, startingHoleForState(S), 1); renderHole(); },
                onPrevious: function () { S.holeIdx = playOrderStep(S.holes, S.holeIdx, startingHoleForState(S), -1); renderHole(); },
                onJumpHole: function (index) { S.holeIdx = index; renderHole(); },
                onScore: postScore,
                clipRecovery: recovery ? { scopeKey: recovery.scope.key, upload: recovery.uploadClip } : null,
                recoveryItems: S.recoveryItems || [],
                lastSavedLie: S.lastSavedLie,
                recoveryStorageError: S.recoveryStorageError,
                recoveryUnavailable: !recovery,
                onRetryRecovery: () => { void flushRecovery('manual'); },
                onDiscardRecovery: discardRecovery,
                onThrows: !finishing && !S.cardLocked && S.status === 'live' ? postThrows : null,
                shotLedger,
                shotStats,
                ledgerScore: ledgerScore?.conflictText ? null : ledgerScore?.currentScore ?? null,
                onRefreshShots: refreshShotLedgers,
                onSaveShots: shotLedger && recovery && !finishing && !S.cardLocked && S.status === 'live'
                    ? (model, rows) => postShots(h, scorerIndex, model, rows) : null,
                onMapMark: memberToken() && S.status !== 'final' ? postMapMark : null,
                onCtpVote: EVENT_ID && !WATCH ? postCtpVote : null,
                onOpenFinish: WATCH ? null : openFinishConfirm,
                onCloseFinish: closeFinishConfirm,
                onAgreeFinish: agreeFinish,
                finishing,
                onScorerChange: function (index) { S.scorerIndex = index; renderHole(); },
                onShare: shareRound,
                onShareCode: ROUND_CODE && S.status === 'live' ? shareJoinCode : null,
                onWatchShare: !ROUND_CODE && EVENT_ID ? shareWatchLink : null,
                roundSharingApi: ROUND_CODE && isCurrentRecovery(recovery) ? (options) => api(LIVE + '/sharing', { ...options, timeout: 8000 }) : null,
                onCopyWatch: shareWatchLink,
                clipGeneration: recovery?.scope.roundId || null,
                joinRequests: S.joinRequests || [],
                onApproveJoin: answerJoinRequest,
                onDeclineJoin: declineJoinRequest,
            });
        }

        // ---------- leaderboard sheet ----------
        let lbOpen = false;
        const leaderboardSheet = createLeaderboardSheetRenderer();
        function openLeaderboard() { lbOpen = true; renderLeaderboard(); }
        if (scoreShell && typeof scoreShell.setLeaderboardHandler === 'function') scoreShell.setLeaderboardHandler(openLeaderboard);
        function closeLeaderboard() { lbOpen = false; leaderboardSheet.close(); }
        function boardStandings(rows) {
            if (!handicapScoringEnabled(S.roundConfig)) return Array.isArray(rows) ? rows : [];
            return decorateStandings(rows, S.handicaps);
        }
        function ensureHandicaps(layoutId) {
            if (!handicapScoringEnabled(S.roundConfig)) {
                S.handicapTicket += 1;
                const had = S.handicaps != null;
                S.handicaps = null;
                S.handicapLayoutId = null;
                S.handicapLoading = false;
                if (had && lbOpen) renderLeaderboard();
                if (had && WATCH) renderWatch();
                return;
            }
            const id = Number(layoutId);
            if (!Number.isInteger(id) || id <= 0) return;
            if (S.handicapLayoutId === id && (S.handicaps || S.handicapLoading)) return;
            const ticket = S.handicapTicket + 1;
            S.handicapTicket = ticket;
            S.handicapLayoutId = id;
            S.handicapLoading = true;
            S.handicaps = null;
            api('/layouts/' + id + '/handicaps', { auth: false, guest: false }).then(function (r) {
                if (S.handicapTicket !== ticket) return;
                const map = Object.create(null);
                const players = r.ok && r.data && Array.isArray(r.data.players) ? r.data.players : [];
                players.forEach(function (row) {
                    if (!row || !row.key || !Number.isFinite(Number(row.start))) return;
                    map[row.key] = { start: Number(row.start), rounds: Number(row.rounds) || 0, provisional: row.provisional === true };
                });
                S.handicaps = map;
                S.handicapLoading = false;
                if (lbOpen) renderLeaderboard();
                if (WATCH) renderWatch();
            });
        }
        function renderLeaderboard() {
            const blockers = finalizeBlockers(S);
            blockers.hint = finishRoundHint(blockers, MODE, S.cardLocked || S.status === 'final');
            leaderboardSheet.render({
                blockers: blockers,
                cardLocked: S.cardLocked,
                exportData: udiscExportData(S),
                isDoubles: isDoublesScoring(S),
                isMatchplay: isMatchplayScoring(S),
                isPutting: isPuttingScoring(S),
                mode: MODE,
                onClose: closeLeaderboard,
                onFinalize: WATCH ? null : openFinishConfirm,
                relClass: relClass,
                relText: relText,
                standings: boardStandings((S.snap && S.snap.standings) || []),
                status: S.status,
                onHole: function (holeNumber) {
                    const index = (S.holes || []).findIndex(function (hole) { return hole && hole.hole === holeNumber; });
                    if (index < 0) return;
                    S.holeIdx = index;
                    closeLeaderboard();
                    renderHole();
                },
                onShare: shareRound,
            });
        }
        function openFinishConfirm() {
            if (WATCH) return;
            readRecovery();
            if (S.recoveryStorageError || S.recoveryItems.length || !isCurrentRecovery(recovery)) {
                toast('Sync this card’s scores and lies before submitting');
                renderHole();
                return;
            }
            if (!finalizeBlockers(S).ready && !S.cardLocked) { toast('Finish the remaining holes first'); return; }
            S.finishConfirmOpen = true;
            closeLeaderboard();
            renderHole();
        }
        function closeFinishConfirm() {
            S.finishConfirmOpen = false;
            renderHole();
        }
        async function agreeFinish(playerIndex) {
            const context = recovery;
            if (!isCurrentRecovery(context) || finishing) return;
            finishing = true;
            renderHole();
            try {
                const perform = async () => {
                    if (!isCurrentRecovery(context)) return;
                    readRecovery(context);
                    if (S.recoveryStorageError || S.recoveryItems.length || !finalizeBlockers(S).ready) {
                        S.finishConfirmOpen = false;
                        toast('Sync this card’s scores and lies before submitting');
                        return;
                    }
                    await submitFinish(playerIndex, context);
                };
                if (navigator.locks && navigator.locks.request) {
                    await navigator.locks.request(context.journal.lockName,
                        () => navigator.locks.request(context.journal.writeLockName, perform));
                } else { await recoveryRun; await perform(); }
            } catch {
                toast('Could not verify this card’s saved changes');
            } finally {
                finishing = false;
                if (isCurrentRecovery(context)) { renderHole(); void flushRecovery(); }
            }
        }
        async function submitFinish(playerIndex, { credential, scope, journal }) {
            if (S.cardLocked && S.status !== 'final') { toast('This card is already submitted'); return; }
            const { roundId, cardId, actorIndex } = scope;
            const finishMark = fieldMark();
            const r = await api(LIVE + '/finish-card', {
                method: 'POST', credential, body: { playerIndex, recovery: { roundId, cardId, actorIndex } }, timeout: 12000,
            });
            if (finishMark) {
                const locked = r.data?.lockedCardIds?.includes(String(cardId));
                fieldLog('round.finish', {
                    roundId, roundCode: ROUND_CODE || null, eventId: EVENT_ID || null, ms: fieldSince(finishMark), status: r.status,
                    result: r.ok ? (r.data?.status === 'final' ? 'final' : locked ? 'locked' : 'agreed') : (r.data?.error || 'error'),
                });
            }
            if (r.ok && (r.data?.status === 'final' || r.data?.lockedCardIds?.includes(String(cardId)))) {
                try { journal.markSubmitted(); } catch { /* the server already locked the card */ }
            }
            if (!sameCredential(credential)) return;
            if (r.ok) {
                S.snap = r.data || S.snap;
                if (r.data && r.data.status === 'final') {
                    S.status = 'final';
                    S.cardLocked = true;
                    S.finishConfirmOpen = false;
                    stopLiveLocation();
                    toast('Round finished');
                } else if (r.data && Array.isArray(r.data.lockedCardIds) && r.data.lockedCardIds.indexOf(String(S.cardId ?? 'c0')) >= 0) {
                    S.cardLocked = true;
                    S.finishConfirmOpen = false;
                    mergeFromSnap();
                    toast('Card submitted');
                } else {
                    if (r.data && r.data.cardAttestation) S.cardAttestation = r.data.cardAttestation;
                    else if (r.data) mergeFromSnap();
                    toast('Agreed');
                }
                renderHole();
                if (lbOpen) renderLeaderboard();
                fieldFinalCheck();
            } else if (r.status === 409 && r.data && r.data.error === 'scorecard_incomplete') {
                if (Array.isArray(r.data.conflicts)) setConflicts(r.data.conflicts);
                if (Array.isArray(r.data.missing)) setMissing(r.data.missing);
                S.finishConfirmOpen = false;
                toast('Can’t finish yet — scores are incomplete');
                renderHole();
            } else if (r.status === 409 && r.data && r.data.error === 'card_locked') {
                S.cardLocked = true;
                S.finishConfirmOpen = false;
                toast('This card is already submitted');
                renderHole();
            } else {
                toast('Couldn’t record that agreement');
            }
        }

        // ---------- boot ----------
        function persistMineCache() {
            if (!isCurrentRecovery(recovery)) return;
            writeMineCache(recovery.cacheKey, {
                recoveryRoundId: recovery.scope.roundId,
                rev: S.lastRev,
                cardAttestation: S.cardAttestation,
                cardId: S.cardId,
                cardLocked: S.cardLocked,
                cardmates: S.cardmates,
                conflicts: S.conflicts,
                courseName: S.courseName,
                holes: S.holes,
                layoutName: S.layoutName,
                missing: S.missing,
                playerIndex: S.myIndex,
                playerLocations: S.playerLocations,
                roundConfig: S.roundConfig,
                scoreTargetError: S.scoreTargetError,
                scoreTargets: S.scoreTargets,
                shotLedgers: S.shotLedgers,
                status: S.status,
                udiscCourseId: S.udiscCourseId,
                weather: S.weather,
            });
        }
        function applyMinePayload(d, options) {
            const { offline, credential, cacheKey } = options;
            const scope = roundRecoveryScope({ roundCode: ROUND_CODE, eventId: EVENT_ID, roundId: d.recoveryRoundId, cardId: d.cardId, playerIndex: d.playerIndex });
            const sameScope = scope && recovery && scope.key === recovery.scope.key;
            if (sameScope && !offline && d.rev != null && d.rev < S.lastRev && S.snap?.players) return;
            bindRecovery(scope, credential, cacheKey);
            if (fieldTestOn()) fieldRedactNames(fieldRoundNames(d));
            S.snap = d;
            S.lastRev = d.rev ?? -1;
            S.status = d.status || null;
            assignHoles(Array.isArray(d.holes) ? d.holes : [], d);
            S.cardId = d.cardId; S.myIndex = d.playerIndex; S.cardmates = d.cardmates;
            mergePrivateShotLedgers(d.shotLedgers);
            S.joinRequests = Array.isArray(d.joinRequests) ? d.joinRequests : [];
            stopJoinPoll();
            S.cardLocked = d.cardLocked === true || (Array.isArray(d.lockedCardIds) && d.lockedCardIds.indexOf(String(d.cardId ?? 'c0')) >= 0);
            S.cardAttestation = d.cardAttestation || { agreedIndexes: [], neededIndexes: [], complete: false };
            S.roundConfig = d.roundConfig || null; S.scoreTargets = Array.isArray(d.scoreTargets) ? d.scoreTargets : []; S.scoreTargetError = d.scoreTargetError || null;
            S.courseName = d.courseName || null; S.layoutName = d.layoutName || null; S.udiscCourseId = d.udiscCourseId || null;
            S.layoutId = d.layoutId || null;
            if (!offline) ensureHandicaps(S.layoutId);
            S.weather = d.weather || null;
            S.playerLocations = Array.isArray(d.playerLocations) ? d.playerLocations : [];
            if (!sameScope) S.scorerIndex = d.playerIndex;
            if (MODE === 'round') {
                const place = [S.courseName, S.layoutName].filter(Boolean).join(' · ');
                rememberRecentRound({ code: ROUND_CODE, label: place || ('Casual round ' + ROUND_CODE) });
            }
            currentScorerIndex();
            setConflicts(d.conflicts);
            setMissing(d.missing);
            if (!sameScope) S.holeIdx = activeHoleIndex({
                holes: S.holes,
                startingHole: startingHoleForState(S),
                isHoleComplete: function (hole) { return cardHoleComplete(S, hole, S.scorerIndex); },
            });
            setShellHeader({
                showLeaderboard: true,
                subtitle: [S.courseName, S.layoutName].filter(Boolean).join(' · ') || 'Greenville Disc Golf Club',
                title: MODE === 'round' ? ('Round ' + ROUND_CODE) : ('Card ' + (S.cardId || ''))
            });
            if (!sameScope && fieldTestOn()) {
                fieldLog('round.open', {
                    mode: MODE, roundCode: ROUND_CODE || null, eventId: EVENT_ID || null, roundId: d.recoveryRoundId || null,
                    cardId: d.cardId ?? null, courseId: d.courseId ?? S.courseId ?? null, layoutId: S.layoutId ?? null,
                    holeCount: S.holes.length, playerCount: Array.isArray(d.cardmates) ? d.cardmates.length : 0,
                    doubles: isDoublesScoring(S), status: S.status, cached: Boolean(offline), rev: d.rev ?? null,
                    pendingEdits: (S.recoveryItems || []).length,
                });
            }
            renderHole();
            if (!offline) connectWs();
            startPotsPolling();
            if (!offline) startLiveLocation();
            void flushRecovery('boot');
            loadPlayingAnchor();
            void wakeLock.start();
            if (offline) { connectWs(); toast('Offline — showing your saved card. Changes sync when reconnected.'); }
            else persistMineCache();
            fieldFinalCheck();
        }
        let ratingAnchorStarted = false;
        async function loadPlayingAnchor() {
            if (ratingAnchorStarted || WATCH || !memberToken()) return;
            ratingAnchorStarted = true;
            const me = await api('/me');
            const pdga = me.ok && me.data ? me.data.pdgaNo : null;
            if (!pdga) return;
            const stats = await api('/pdga-stats?pdga=' + encodeURIComponent(String(pdga)), { auth: false, guest: false });
            const rating = stats.ok && stats.data ? Number(stats.data.official_rating) : NaN;
            if (!Number.isFinite(rating) || rating <= 0) return;
            S.officialRating = rating;
            renderHole();
        }
        async function loadMine() {
            const ticket = ++mineRequest;
            const credential = scoringCredential();
            const active = () => ticket === mineRequest && sameCredential(credential);
            const cacheKey = await secureMineCacheKey(ROUND_CODE, EVENT_ID, credential.token).catch(() => '');
            if (!active()) return;
            let r = await api(LIVE + '/mine', { credential, timeout: 10000 });
            if (!active()) return;
            // Casual round: if we're not on it yet, join with the code, then re-load our card.
            // Once a hole is scored, the card has to approve the join before we are added.
            if (MODE === 'round' && r.ok && r.data && r.data.cardId == null && r.data.status === 'live') {
                if (r.data.pendingJoin) {
                    S.snap = r.data;
                    S.status = r.data.status;
                    renderJoinWait('waiting');
                    startJoinPoll();
                    return;
                }
                const jr = await api('/rounds/' + ROUND_CODE + '/join', { method: 'POST', body: {}, credential });
                if (!active()) return;
                if (jr.ok && jr.data && jr.data.pendingJoin) {
                    S.snap = r.data;
                    S.status = r.data.status;
                    renderJoinWait('waiting');
                    startJoinPoll();
                    return;
                }
                if (!jr.ok) {
                    renderMessage(
                        'Could not join this card',
                        jr.data && jr.data.error === 'join_full' ? 'Too many people are already waiting on this card.' : 'Check the code and try again.',
                        true,
                    );
                    return;
                }
                if (jr.ok) r = await api(LIVE + '/mine', { credential, timeout: 10000 });
                if (!active()) return;
            }
            if (r.status === 401 || r.status === 403) {
                fieldLog('auth.expired', { status: r.status, where: 'card' });
                stopRecovery();
                renderLogin('Sign in to sync any saved scores, lies and clips.');
                return;
            }
            if (!r.ok || !r.data) {
                const cached = isTransientMineFailure(r) ? readMineCache(cacheKey) : null;
                if (cached) { applyMinePayload(cached, { offline: true, credential, cacheKey }); return; }
                renderMessage('Couldn’t load your card', 'Check your connection and try again.', true); return;
            }
            const d = r.data;
            if (d.cardId == null || !Array.isArray(d.cardmates) || !d.cardmates.length) {
                if (MODE === 'round') {
                    forgetRecentRound(ROUND_CODE);
                    renderMessage('Round not found', 'That round code isn’t active. Double-check it, or start a new round.', true);
                }
                else renderMessage('No card yet', 'Either the round hasn’t started or you’re not on a card for this event. Ask an admin to start the round and assign cards.', true);
                return;
            }
            applyMinePayload(d, { credential, cacheKey });
        }
        let joinPoll = null;
        function stopJoinPoll() {
            if (!joinPoll) return;
            clearInterval(joinPoll);
            joinPoll = null;
        }
        function renderJoinWait(kind) {
            renderStatusView({
                action: kind === 'declined' ? { label: 'Ask again', onClick: requestJoinAgain } : null,
                mode: 'message',
                onLeaderboard: openLeaderboard,
                sub: kind === 'declined'
                    ? 'Ask again if you still want on this card.'
                    : 'A hole is already scored. Someone on the card has to approve you before you are added.',
                title: kind === 'declined' ? 'The card said no' : 'Waiting on the card',
            });
        }
        function startJoinPoll() {
            if (joinPoll) return;
            joinPoll = setInterval(function () { pollJoin(); }, 3000);
        }
        async function pollJoin() {
            const next = await api(LIVE + '/mine');
            if (!next.ok || !next.data || next.data.status !== 'live') return;
            if (next.data.cardId != null) {
                stopJoinPoll();
                await loadMine();
                return;
            }
            if (!next.data.pendingJoin) {
                stopJoinPoll();
                S.snap = next.data;
                renderJoinWait('declined');
            }
        }
        async function requestJoinAgain() {
            const jr = await api('/rounds/' + ROUND_CODE + '/join', { method: 'POST', body: {} });
            if (jr.ok && jr.data && jr.data.pendingJoin) {
                renderJoinWait('waiting');
                startJoinPoll();
                return;
            }
            if (jr.ok) {
                await loadMine();
            }
        }
        async function answerJoinRequest(id) {
            const response = await api('/rounds/' + ROUND_CODE + '/join-approve', { method: 'POST', body: { id: id } });
            if (response.ok && response.data && Array.isArray(response.data.cardmates)) await loadMine();
            else toast('Could not add them to the card.');
        }
        async function declineJoinRequest(id) {
            const response = await api('/rounds/' + ROUND_CODE + '/join-decline', { method: 'POST', body: { id: id } });
            if (response.ok && response.data && Array.isArray(response.data.cardmates)) await loadMine();
            else toast('Could not update that request.');
        }

        // ---- casual round: home, course/layout pickers, create, add guest ----
        function cleanRoundCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
        function joinRoundCode(value) {
            const code = cleanRoundCode(value);
            if (code.length >= 4) location.search = '?round=' + code;
            else toast('Enter a valid code');
        }
        function signOut() { stopRecovery(); clearMemberSession(); wakeLock.stop(); notifyScoreAuthChanged(); if (MODE === 'home') renderHome(); else renderLogin(); }
        function renderHome() {
            renderSetupFlow({
                view: 'home',
                signedIn: !!memberToken(),
                playerName: memberToken() ? '' : readOpenPlayName(),
                onStart: startCasualSetup,
                onJoin: joinRoundCode,
                onWatch: watchRoundCode,
                onInvalidCode: function () { toast('Enter a valid code'); },
                onSignOut: signOut,
                onSignIn: function () { renderLogin(); }
            });
            pruneLeftRounds().then(function (changed) {
                if (changed && MODE === 'home') renderHome();
            });
        }
        async function renderCourseMap(query) {
            renderLoading();
            const listed = await api('/courses', { auth: false });
            const courses = (listed.ok && listed.data && listed.data.courses) || [];
            const course = matchCourseByName(courses, query);
            if (!course) {
                toast('That course is not in the club app yet.');
                renderHome();
                return;
            }
            const layoutRes = await api('/courses/' + encodeURIComponent(course.id) + '/layouts', { auth: false });
            const layouts = sortLayoutsForPick((layoutRes.ok && layoutRes.data && layoutRes.data.layouts) || []);
            const layout = layouts[0] || null;
            const holes = layoutHoles(layout).filter((hole) => hole && hole.tee && hole.target);
            let holeIndex = 0;
            const paint = () => {
                renderSetupFlow({
                    view: 'courseMap',
                    course: course,
                    layout: layout,
                    holes: holes,
                    holeIndex: holeIndex,
                    missing: !holes.length,
                    onHole: function (index) { holeIndex = index; paint(); },
                    onBack: function () { history.replaceState(null, '', 'score.html'); renderHome(); },
                    onStart: function () {
                        if (!hasScoringIdentity()) { renderOpenPlay(function () { renderLayoutPick(course); }); return; }
                        renderLayoutPick(course);
                    },
                });
            };
            paint();
        }
        function startCasualSetup() {
            if (!hasScoringIdentity()) { renderOpenPlay(function () { renderCoursePick(); }); return; }
            renderCoursePick();
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
            return { groupFormat: 'singles', scoringStyle: 'stroke', handicap: false };
        }
        function renderSetupPick(course, layout, notice) {
            renderSetupFlow({
                view: 'setupPick',
                course: course,
                layout: layout,
                defaultConfig: defaultLiveScoringConfig(),
                notice: notice || '',
                onBack: function () { renderLayoutPick(course); },
                onCreate: function (selected) { createRound(course, layout, selected); }
            });
        }
        async function createRound(course, layout, config, retry) {
            const liveScoringConfig = config || defaultLiveScoringConfig();
            const requested = cleanRoundCode(liveScoringConfig.code);
            if (String(liveScoringConfig.code || '').trim() && (requested.length < 4 || requested.length > 12)) {
                renderSetupPick(course, layout, 'Use 4–12 letters or numbers.');
                return;
            }
            renderLoading();
            const body = { course_id: course.id, layout_id: layout.id, liveScoringConfig: { groupFormat: liveScoringConfig.groupFormat, scoringStyle: liveScoringConfig.scoringStyle, handicap: liveScoringConfig.handicap === true && liveScoringConfig.scoringStyle !== 'matchplay' } };
            if (requested) body.code = requested;
            const createMark = fieldMark();
            const r = await api('/rounds', { method: 'POST', body: body });
            if (createMark) {
                fieldLog('round.create', { ok: r.ok, status: r.status, ms: fieldSince(createMark), roundCode: r.data?.code || null,
                    courseId: course.id ?? null, layoutId: layout.id ?? null, groupFormat: body.liveScoringConfig.groupFormat });
            }
            if (r.ok && r.data && r.data.code) {
                rememberLastCourse(course);
                location.search = '?round=' + r.data.code;
                return;
            }
            if (r.status === 401) {
                if (!retry && memberToken()) {
                    clearMemberSession();
                    notifyScoreAuthChanged();
                    if (readOpenPlayToken()) return createRound(course, layout, liveScoringConfig, true);
                }
                if (!retry) {
                    renderOpenPlay(function () { createRound(course, layout, liveScoringConfig, true); });
                    return;
                }
            }
            if (r.data && r.data.error === 'code_taken') { renderSetupPick(course, layout, 'That code is already in use. Pick another.'); return; }
            if (r.data && r.data.error === 'invalid_code') { renderSetupPick(course, layout, 'Use 4–12 letters or numbers.'); return; }
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
            if (r.data.cardId == null) {
                forgetRecentRound(ROUND_CODE);
                location.href = location.pathname;
                return;
            } // I left the round → back to home
            S.cardId = r.data.cardId; S.myIndex = r.data.playerIndex; S.cardmates = Array.isArray(r.data.cardmates) ? r.data.cardmates : S.cardmates;
            renderHole();
            toast(p.name + ' removed');
        }
        function shareRound() {
            const url = shareCardUrl();
            const model = buildShareCard(S, {
                now: new Date(),
                roundCode: "",
                scorerIndex: currentScorerIndex(),
            });
            const title = model.course && model.course !== "Disc golf"
                ? ("GVDG · " + model.course)
                : "GVDG scorecard";
            const text = shareCardText(model, url);
            shareRoundPayload(model, { title: title, text: text, url: url });
        }
        function shareCardUrl() {
            if (ROUND_CODE) return "";
            if (EVENT_ID) return location.origin + location.pathname + "?event=" + EVENT_ID + "&watch=1";
            return location.origin + location.pathname;
        }
        async function shareRoundPayload(model, payload) {
            let file = null;
            if (model && model.scored) {
                try {
                    file = shareCardFile(await shareCardPng(model), model);
                } catch {
                    file = null;
                }
            }
            if (file && canShareFiles(file)) {
                navigator.share({
                    files: [file],
                    title: payload.title,
                    text: payload.text,
                    ...(payload.url ? { url: payload.url } : {}),
                }).catch(function () {});
                return;
            }
            if (file) downloadShareFile(file);
            if (navigator.share) {
                navigator.share({ title: payload.title, text: payload.text, ...(payload.url ? { url: payload.url } : {}) }).catch(function () {});
                if (file) toast("Scorecard saved");
                return;
            }
            if (navigator.clipboard && payload.url) {
                navigator.clipboard.writeText(payload.url).then(function () {
                    toast(file ? "Scorecard saved · link copied" : "Link copied");
                }).catch(function () { toast(payload.url); });
                return;
            }
            if (file) toast("Scorecard saved");
            else if (payload.url) toast(payload.url);
            else toast("Couldn’t share this scorecard");
        }
        function shareJoinCode() {
            if (!ROUND_CODE) { shareWatchLink(); return; }
            const join = location.origin + location.pathname + "?round=" + ROUND_CODE;
            const text = "Join my card — code " + ROUND_CODE;
            const payload = { title: "GVDG round " + ROUND_CODE, text: text, url: join };
            if (navigator.share) {
                navigator.share(payload).catch(function () {});
                return;
            }
            const full = text + "\n" + join;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(full).then(function () { toast("Code " + ROUND_CODE + " copied"); }).catch(function () { toast(ROUND_CODE); });
                return;
            }
            toast("Code " + ROUND_CODE);
        }
        function watchHref() {
            return liveWatchHref({ eventId: EVENT_ID, roundCode: ROUND_CODE });
        }
        async function shareWatchLink(key = WATCH_KEY) {
            const path = typeof key === "string" ? "score.html?watch=1" : watchHref();
            if (!path) return false;
            const url = watchUrl(path, location, typeof key === "string" ? key : null);
            try {
                await navigator.clipboard.writeText(url);
                toast('Watch link copied');
                return true;
            } catch {
                await dialogs.prompt({ title: 'Copy watch link', label: 'Watch link', initialValue: url, readOnly: true, confirmText: 'Done' });
                return true;
            }
        }
        function renderWatch() {
            const snap = watchState.snapshot;
            const pots = buildLivePots({ acePot: S.pots && S.pots.acePot, ctps: S.pots && S.pots.ctps, roundStatus: S.status });
            setShellHeader({
                showLeaderboard: false,
                subtitle: snap ? [S.courseName, S.layoutName].filter(Boolean).join(' · ') || 'Live scoring' : 'Live scoring',
                title: snap?.status === 'final' ? 'Final' : 'Watch round',
            });
            renderScoreBody('watch', {
                connection: watchState.phase,
                receivedAt: watchState.receivedAt,
                updatedAt: snap?.updatedAt,
                hasSnapshot: Boolean(snap),
                courseName: S.courseName,
                holes: snap ? watchHoleViews() : [],
                isDoubles: isDoublesScoring(S),
                isMatchplay: isMatchplayScoring(S),
                isPutting: isPuttingScoring(S),
                layoutName: S.layoutName,
                layoutId: S.layoutId || snap?.layoutId || null,
                onCopyLink: snap && (EVENT_ID || WATCH_KEY || S.watchAudience === "public") ? () => shareWatchLink() : null,
                onReconnect: () => spectator?.retry(),
                pots,
                relClass: relClass,
                relText: relText,
                showPots: pots.visible,
                showWeather: Boolean(S.weather),
                standings: boardStandings(Array.isArray(snap?.standings) ? snap.standings : []),
                status: S.status,
                generation: snap?.recoveryRoundId || null,
                canManageClips: Boolean(snap && !WATCH_KEY && scoringToken()),
                roundSharingApi: ROUND_CODE && !WATCH_KEY && scoringToken() ? (options) => api(LIVE + '/sharing', { ...options, timeout: 8000 }) : null,
                onOwnerCopyWatch: shareWatchLink,
                udiscCourseId: S.udiscCourseId || '',
                weather: S.weather,
                windFromDeg: S.weather && S.weather.current ? S.weather.current.windDirectionDeg : null,
                playerLocations: [],
                players: Array.isArray(snap?.players) ? snap.players : [],
                scoreTargets: Array.isArray(snap?.scoreTargets) ? snap.scoreTargets : [],
                activeHoleIndex: fieldActiveHoleIndex({
                    holes: S.holes,
                    players: Array.isArray(snap?.players) ? snap.players : [],
                }),
            });
        }
        function startWatch() {
            if (spectator) { spectator.retry(); return; }
            function get(path) {
                return api(path, { auth: !WATCH_KEY && Boolean(ROUND_CODE), guest: false, headers: spectatorHeaders(WATCH_KEY), timeout: 8500 });
            }
            spectator = createSpectatorTransport({
                fetchSnapshot: async () => {
                    const response = await get(LIVE);
                    const data = response.ok ? response.data : null;
                    if (watchableLiveSnapshot(data)) return { snapshot: data, status: response.status };
                    if ((ROUND_CODE || WATCH_KEY) && response.ok) {
                        const results = await get(WATCH_KEY ? '/watch-round/results' : '/rounds/' + ROUND_CODE + '/results');
                        const replay = casualReplaySnapshot(results.ok ? results.data : null);
                        return { snapshot: replay, status: results.status };
                    }
                    return { status: response.status };
                },
                openSocket: () => fieldWatchSocket(new WebSocket(API_BASE.replace(/^http/, 'ws') + LIVE + '/ws',
                    spectatorSocketProtocols(WATCH_KEY, ROUND_CODE ? scoringToken() : null)), 'spectator'),
                onState: (next) => {
                    const changed = next.snapshot !== watchState.snapshot;
                    watchState = next;
                    if (changed && next.snapshot) {
                        const d = next.snapshot;
                        if (fieldTestOn()) {
                            fieldRedactNames(fieldRoundNames(d));
                            fieldLiveUpdate('spectator', d);
                        }
                        S.snap = d;
                        if (d.viewerAudience) S.watchAudience = d.viewerAudience;
                        S.status = d.status;
                        S.courseName = d.courseName || null;
                        S.layoutName = d.layoutName || null;
                        S.layoutId = d.layoutId || null;
                        S.udiscCourseId = d.udiscCourseId || null;
                        S.roundConfig = d.roundConfig || null;
                        S.weather = d.weather || null;
                        assignHoles(Array.isArray(d.holes) ? d.holes : [], d);
                        ensureHandicaps(S.layoutId);
                        if (S.pots) S.pots.ctps = withLiveCtpLeaders(S.pots.ctps, d.liveCtps);
                    } else if (!next.snapshot) {
                        S.snap = null;
                        S.watchAudience = null;
                        S.status = null;
                    }
                    renderWatch();
                },
            });
            spectator.start();
            startPotsPolling();
        }
        function watchRoundCode(value) {
            const code = cleanRoundCode(value);
            if (code.length >= 4) location.search = '?round=' + code + '&watch=1';
            else toast('Enter a valid code');
        }

        async function boot() {
            if (!isCurrentRecovery(recovery)) stopRecovery();
            setOnline(navigator.onLine);
            if (WATCH && (EVENT_ID || ROUND_CODE || WATCH_KEY)) {
                startWatch();
                return;
            }
            if (MODE === 'home') {
                if (offlineReturn) { renderLogin(); return; }
                if (COURSE_QUERY) { renderCourseMap(COURSE_QUERY); return; }
                if (params.get('start') === '1') {
                    history.replaceState(null, '', 'score.html');
                    startCasualSetup();
                    return;
                }
                renderHome();
                return;
            }
            if (MODE === 'event' && !memberToken() && !GUEST_TOKEN) { renderLogin(); return; }
            if (MODE === 'round' && !hasScoringIdentity()) { renderOpenPlay(); return; }
            renderLoading();
            await loadMine();
        }
        boot();
}
