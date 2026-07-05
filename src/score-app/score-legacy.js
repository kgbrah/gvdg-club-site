export function startScoreApp() {
        "use strict";
        // --- API base: explicit data-api-base wins; else resolve by host (prod vs gvdgclub.com dev/previews). ---
        const _h = location.hostname;
        const LOCAL = ['127.0.0.1', 'localhost'].includes(_h) ? 'http://127.0.0.1:8788' : '';
        const API_BASE = (LOCAL || (document.body.dataset.apiBase || '').trim() ||
            ((_h === 'greenvillediscgolf.com' || _h === 'www.greenvillediscgolf.com') ? 'https://auth.greenvillediscgolf.com' : 'https://auth.gvdgclub.com')).replace(/\/+$/, '');

        const TOKEN_KEY = 'gvdg_member_token', NAME_KEY = 'gvdg_member_name', GUESTREG_KEY = 'gvdg_guest_regs', RECENT_ROUNDS_KEY = 'gvdg_recent_rounds';
        const params = new URLSearchParams(location.search);
        const EVENT_ID = (params.get('event') || '').replace(/[^0-9]/g, '');
        const ROUND_CODE = (params.get('round') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const MODE = ROUND_CODE ? 'round' : (EVENT_ID ? 'event' : 'home'); // event scoring · casual round · home
        const LIVE = ROUND_CODE ? ('/rounds/' + ROUND_CODE + '/live') : ('/events/' + EVENT_ID + '/live');
        // A guest scores an EVENT via their registration token (URL ?gt= or saved at registration); casual
        // rounds are members-only, so there is no guest token there.
        function guestTokenStored() { try { const a = JSON.parse(localStorage.getItem(GUESTREG_KEY) || '{}'); return (a[EVENT_ID] && a[EVENT_ID].guestToken) || null; } catch (e) { return null; } }
        const GUEST_TOKEN = MODE === 'event' ? (params.get('gt') || guestTokenStored()) : null;

        const app = document.getElementById('app');
        const S = { holes: [], cardId: null, myIndex: null, scorerIndex: null, cardmates: [], snap: null, holeIdx: 0, ws: null, wsTimer: null, status: null, conflicts: [], missing: [], courseName: null, layoutName: null, lastRev: -1, udiscCourseId: null, roundConfig: null, scoreTargets: [], scoreTargetError: null, weather: null };
        const pending = new Map();            // pendingKey -> in-flight count (refcount: concurrent taps on one cell each stay protected until their own POST returns)
        const QKEY = 'gvdg_score_queue:' + (ROUND_CODE || EVENT_ID);

        // ---------- tiny helpers ----------
        function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
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
        function relClass(d) { return d < 0 ? 'under' : d > 0 ? 'over' : 'even'; }
        function relText(d) { return d === 0 ? 'E' : d > 0 ? '+' + d : String(d); }
        function toast(msg) {
            const t = el('div', 'toast', msg); document.body.appendChild(t);
            setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 1800);
            setTimeout(() => t.remove(), 2200);
        }
        // A loud, sticky, top-of-screen alert (with a buzz) when the card has a scoring conflict. Tap to dismiss.
        function conflictAlert(msg) {
            if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) {} }
            const values = Array.isArray(msg.values) && msg.values.length ? msg.values.join(' vs ') : ((msg.from != null && msg.to != null) ? (msg.from + ' vs ' + msg.to) : 'scores do not match');
            const text = '⚠️ Scoring conflict — Hole ' + msg.hole + ', ' + (msg.playerName || 'a player') + ': ' + values + '. Confirm with your card.';
            const t = el('div', 'toast conflict', text);
            t.addEventListener('click', () => t.remove());
            document.body.appendChild(t);
            setTimeout(() => { t.style.opacity = '0'; }, 6500);
            setTimeout(() => t.remove(), 7100);
        }

        // ---------- theme ----------
        if (localStorage.getItem('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        document.getElementById('themeBtn').addEventListener('click', function () {
            const dark = document.documentElement.getAttribute('data-theme') === 'dark';
            if (dark) { document.documentElement.removeAttribute('data-theme'); localStorage.setItem('theme', 'light'); }
            else { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('theme', 'dark'); }
        });

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
                    const alert = el('div', 'toast conflict',
                        '⚠️ ' + rejected.length + ' offline score' + (rejected.length > 1 ? 's were' : ' was') +
                        ' rejected and NOT saved (hole' + (rejected.length > 1 ? 's' : '') + ' ' + holes + '). Please re-enter. Tap to dismiss.');
                    alert.addEventListener('click', function () { alert.remove(); });
                    document.body.appendChild(alert);
                    if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) {} }
                } else if (q.length && !remain.length) {
                    toast('Synced offline scores');
                }
            })();
            try { return await flushQueuePromise; }
            finally { flushQueuePromise = null; }
        }

        // ---------- offline bar ----------
        let offlineBar = null;
        function setOnline(on) {
            if (on && offlineBar) { offlineBar.remove(); offlineBar = null; }
            else if (!on && !offlineBar) { offlineBar = el('div', 'offline-bar', '⚠ Offline — scores save on your phone and sync when you reconnect'); document.body.appendChild(offlineBar); }
        }
        window.addEventListener('online', function () { setOnline(true); flushQueue(); connectWs(); });
        window.addEventListener('offline', function () { setOnline(false); });

        // ---------- score state access ----------
        function scorecardChoices() {
            return S.cardmates.filter((p) => p && p.canEnterScorecard !== false);
        }
        function currentScorerIndex() {
            const choices = scorecardChoices();
            if (!choices.length) return null;
            if (choices.some((p) => p.index === S.scorerIndex)) return S.scorerIndex;
            const mine = choices.find((p) => p.index === S.myIndex);
            S.scorerIndex = (mine || choices[0]).index;
            return S.scorerIndex;
        }
        function pendingKey(scorerIndex, index, hole, targetId) {
            return scorerIndex + ':' + (targetId ? ('target:' + targetId) : ('index:' + index)) + ':' + hole;
        }
        function hasPendingScore(index, hole) {
            const legacySuffix = ':index:' + index + ':' + hole;
            for (const key of pending.keys()) {
                if (key.endsWith(legacySuffix)) return true;
                const target = targetForPlayer(index);
                if (target && key.endsWith(':target:' + target.id + ':' + hole)) return true;
            }
            return false;
        }
        function isDoublesScoring() {
            return S.roundConfig && S.roundConfig.groupFormat === 'doubles';
        }
        function isMatchplayScoring() {
            return S.roundConfig && S.roundConfig.scoringStyle === 'matchplay';
        }
        function targetForPlayer(index) {
            return (S.scoreTargets || []).find(function (target) { return target && Array.isArray(target.playerIndexes) && target.playerIndexes.indexOf(index) >= 0; }) || null;
        }
        function scoreRows() {
            if (!isDoublesScoring()) {
                return S.cardmates.map(function (p) { return { type: 'player', index: p.index, label: p.name + (p.isMe ? ' (you)' : ''), meta: p.division || '', playerIndexes: [p.index] }; });
            }
            const cardIndexes = new Set(S.cardmates.map(function (p) { return p.index; }));
            return (S.scoreTargets || []).reduce(function (rows, target) {
                if (target && target.type === 'pair' && target.playerIndexes.some(function (index) { return cardIndexes.has(index); })) {
                    rows.push({
                        type: 'pair',
                        targetId: target.id,
                        label: target.label,
                        meta: (target.members || []).join(' / '),
                        playerIndexes: target.playerIndexes || []
                    });
                }
                return rows;
            }, []);
        }
        function strokesFor(index, hole) {
            const cm = S.cardmates.find((p) => p.index === index);
            if (!cm) return null;
            // Show the SELECTED scorecard's OWN vote for this player, so you can see and dial your own number
            // even during a conflict (when the consensus score is intentionally blank). Fall back to the
            // agreed/consensus value when this scorecard hasn't voted on the hole yet.
            const sIdx = currentScorerIndex();
            const votes = cm.scorecards && cm.scorecards[hole];
            if (sIdx != null && votes && typeof votes['player:' + sIdx] === 'number') return votes['player:' + sIdx];
            const v = cm.scores ? cm.scores[hole] : undefined;
            return (typeof v === 'number') ? v : null;
        }
        function strokesForRow(row, hole) {
            const index = row.playerIndexes && row.playerIndexes[0];
            return Number.isInteger(index) ? strokesFor(index, hole) : null;
        }
        function setLocal(index, hole, strokes) {
            const cm = S.cardmates.find((p) => p.index === index);
            if (!cm) return;
            // Optimistically record the SELECTED scorecard's own vote (not the consensus) so the number sticks
            // and can be incremented during a conflict instead of snapping back to blank.
            const sIdx = currentScorerIndex();
            cm.scorecards = cm.scorecards || {};
            cm.scorecards[hole] = Object.assign({}, cm.scorecards[hole]);
            if (sIdx != null) cm.scorecards[hole]['player:' + sIdx] = strokes;
            // Also reflect it as this card's score so the player's own Thru/Total/To-par bar and the
            // hole-grid "done" dots update immediately (and offline). mergeFromSnap re-blanks it after the
            // round-trip if it's a genuine conflict; the stepper reads the per-scorer vote first regardless.
            cm.scores = cm.scores || {};
            cm.scores[hole] = strokes;
        }
        function setLocalRow(row, hole, strokes) {
            (row.playerIndexes || []).forEach(function (index) { setLocal(index, hole, strokes); });
        }
        function setConflicts(rows) {
            S.conflicts = (Array.isArray(rows) ? rows : []).filter((c) => c && c.cardId === S.cardId);
        }
        function setMissing(rows) {
            // Holes where a member cardmate hasn't confirmed a score yet (guests are optional). Drives the
            // "what's blocking finalize" panel; scoped to our own card.
            S.missing = (Array.isArray(rows) ? rows : []).filter((m) => m && m.cardId === S.cardId);
        }
        function upsertConflict(msg) {
            if (!msg || msg.cardId !== S.cardId) return;
            S.conflicts = S.conflicts.filter((c) => !((msg.targetId && c.targetId === msg.targetId || !msg.targetId && c.playerIndex === msg.playerIndex) && c.hole === msg.hole));
            if (Array.isArray(msg.values) && msg.values.length > 1) S.conflicts.push({ cardId: msg.cardId, playerIndex: msg.playerIndex, playerName: msg.playerName, targetId: msg.targetId, label: msg.label, hole: msg.hole, values: msg.values });
        }
        function conflictFor(index, hole) {
            return S.conflicts.find((c) => c && c.playerIndex === index && c.hole === hole) || null;
        }
        function conflictForRow(row, hole) {
            if (row.targetId) return S.conflicts.find((c) => c && c.targetId === row.targetId && c.hole === hole) || null;
            return conflictFor(row.index, hole);
        }
        function holeHasConflict(hole) {
            return S.conflicts.some((c) => c && c.hole === hole);
        }
        // Dormie: the leader is up by exactly the holes remaining, so a win OR a halve of THIS hole ends the
        // match. Flagged prominently on the hole so the card knows it's match point.
        function isMatchDormie() {
            if (!isMatchplayScoring() || !S.snap || !Array.isArray(S.snap.standings)) return false;
            return S.snap.standings.some(function (s) { return s.match && s.match.dormie; });
        }
        function matchStatusText() {
            if (!isMatchplayScoring() || !S.snap || !Array.isArray(S.snap.standings)) return '';
            const cardTargets = scoreRows().map(function (row) { return row.targetId || ('player:' + row.index); });
            const rows = S.snap.standings.filter(function (standing) { return cardTargets.indexOf(standing.targetId) >= 0; });
            const withMatch = rows.find(function (standing) { return standing.match && standing.match.status; });
            return withMatch && withMatch.match ? ('Match: ' + withMatch.match.status) : '';
        }
        function myScoreRow() {
            return scoreRows().find(function (row) { return row.playerIndexes.indexOf(S.myIndex) >= 0; }) || null;
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
            // Apply weather FIRST, in place: the background weather refresh broadcasts a same-rev snapshot
            // (weather isn't a scoring change), so the rev gate below would otherwise drop it and the strip
            // would never update. Updating just the strip avoids a full renderHole that resets scroll/inputs.
            if (Object.prototype.hasOwnProperty.call(snap, 'weather')) { S.weather = snap.weather || null; refreshWeatherStrip(); }
            // Drop a stale/out-of-order snapshot (a newer one from another device was already applied).
            if (snap.rev != null) { if (snap.rev <= S.lastRev) return; S.lastRev = snap.rev; }
            if (snap.status) S.status = snap.status; // reflect a finalize (or start) that happened on another device
            S.roundConfig = snap.roundConfig || S.roundConfig;
            S.scoreTargets = Array.isArray(snap.scoreTargets) ? snap.scoreTargets : S.scoreTargets;
            S.scoreTargetError = myScoreTargetError(snap);
            setConflicts(snap.conflicts);
            setMissing(snap.missing);
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
                        const target = targetForPlayer(cm.index);
                        if (Number.isInteger(sidx) && (pending.has(pendingKey(sidx, cm.index, hh.hole, null)) || (target && pending.has(pendingKey(sidx, null, hh.hole, target.id))))) votes[sid] = local[sid];
                    });
                    if (Object.keys(votes).length) cm.scorecards[hh.hole] = votes; else delete cm.scorecards[hh.hole];
                });
            });
            renderHole();
            if (lbOpen) renderLeaderboard();
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
                if (msg && msg.type === 'conflict') { if (msg.cardId === S.cardId) { upsertConflict(msg); conflictAlert(msg); renderHole(); } return; }
                if (msg && msg.type === 'snapshot') { S.snap = msg; mergeFromSnap(); }
            });
            ws.addEventListener('close', function () { if (S.wsTimer) return; S.wsTimer = setTimeout(function () { S.wsTimer = null; connectWs(); }, 4000); });
            ws.addEventListener('error', function () { try { ws.close(); } catch (e) {} });
        }

        // ---------- views ----------
        function shell(node) { app.replaceChildren(node); }

        function renderMessage(title, sub, withRetry) {
            const c = el('div', 'card center stack');
            c.appendChild(el('h2', 'section', title));
            if (sub) c.appendChild(el('p', 'muted', sub));
            if (withRetry) { const b = el('button', 'btn', 'Try again'); b.addEventListener('click', boot); c.appendChild(b); }
            const lb = el('button', 'btn secondary', '🏆 View live leaderboard');
            lb.addEventListener('click', openLeaderboard);
            c.appendChild(lb);
            shell(c);
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
        async function loginWithPasskey(errEl, btn) {
            if (!passkeysSupported()) { if (errEl) errEl.textContent = 'Passkeys aren’t supported on this device.'; return; }
            if (btn) btn.disabled = true; if (errEl) errEl.textContent = '';
            try {
                let options, flowId; const pf = passkeyPrefetch; passkeyPrefetch = null; // single use, no await before get()
                if (pf && Date.now() - pf.ts < 290000) { options = pf.options; flowId = pf.flowId; }
                else { const r = await api('/webauthn/auth/options', { method: 'POST', auth: false, guest: false }); if (!r.ok || !r.data) throw new Error('options'); options = r.data.options; flowId = r.data.flowId; }
                options.challenge = b64urlToBuf(options.challenge);
                if (options.allowCredentials) options.allowCredentials = options.allowCredentials.map(function (c) { return Object.assign({}, c, { id: b64urlToBuf(c.id) }); });
                const a = await navigator.credentials.get({ publicKey: options });
                const body = { flowId, response: { id: a.id, rawId: bufToB64url(a.rawId), type: a.type, response: { clientDataJSON: bufToB64url(a.response.clientDataJSON), authenticatorData: bufToB64url(a.response.authenticatorData), signature: bufToB64url(a.response.signature), userHandle: a.response.userHandle ? bufToB64url(a.response.userHandle) : undefined }, clientExtensionResults: a.getClientExtensionResults ? a.getClientExtensionResults() : {} } };
                const v = await api('/webauthn/auth/verify', { method: 'POST', auth: false, guest: false, body });
                if (v.status === 200 && v.data && v.data.token) afterAuth(v.data);
                else if (errEl) errEl.textContent = 'Passkey sign-in failed. Use your PIN instead.';
            } catch (e) {
                if (errEl) errEl.textContent = (e && e.name === 'NotAllowedError') ? 'Passkey sign-in cancelled.' : 'Passkey sign-in failed. Use your PIN instead.';
            } finally { if (btn) btn.disabled = false; prefetchPasskey(); }
        }
        // After any successful auth (PIN or passkey): store the token, then force the PIN change if the
        // account still requires it — the must-change-PIN gate rejects EVERY protected route (incl. joining
        // a card), so without this a temp-PIN member logs in but gets bounced right back to the login screen.
        function afterAuth(data) {
            try { sessionStorage.setItem(TOKEN_KEY, data.token); if (data.name) sessionStorage.setItem(NAME_KEY, data.name); } catch (e) {}
            if (data.mustChangePin) renderSetPin();
            else boot();
        }
        function renderSetPin(message) {
            const c = el('div', 'card stack');
            c.appendChild(el('h2', 'section', 'Set your PIN'));
            c.appendChild(el('p', 'muted', message || 'Choose a new 4-digit PIN to finish signing in.'));
            const np = el('input', 'field'); np.type = 'password'; np.inputMode = 'numeric'; np.maxLength = 4; np.placeholder = 'New 4-digit PIN'; np.autocomplete = 'new-password';
            const cp = el('input', 'field'); cp.type = 'password'; cp.inputMode = 'numeric'; cp.maxLength = 4; cp.placeholder = 'Confirm PIN'; cp.autocomplete = 'new-password';
            const err = el('p', 'muted'); err.style.color = 'var(--over)'; err.style.minHeight = '1rem';
            const btn = el('button', 'btn', 'Save PIN & continue');
            btn.addEventListener('click', async function () {
                const a = np.value.trim(), b = cp.value.trim();
                if (!/^\d{4}$/.test(a)) { err.textContent = 'PIN must be exactly 4 digits.'; return; }
                if (a !== b) { err.textContent = 'PINs don’t match.'; return; }
                btn.disabled = true; err.textContent = '';
                const r = await api('/set-pin', { method: 'POST', guest: false, body: { newPin: a } });
                btn.disabled = false;
                if (r.status === 200 && r.data && r.data.token) { try { sessionStorage.setItem(TOKEN_KEY, r.data.token); } catch (e) {} boot(); }
                else if (r.status === 401) { renderLogin('Please sign in again.'); }
                else { err.textContent = 'Could not update PIN — try again.'; }
            });
            c.appendChild(np); c.appendChild(cp); c.appendChild(err); c.appendChild(btn);
            shell(c);
        }

        function renderLogin(message) {
            const c = el('div', 'card stack');
            c.appendChild(el('h2', 'section', 'Sign in to keep score'));
            if (message) c.appendChild(el('p', 'muted', message));
            const idL = el('label', 'lbl', 'PDGA # or UDisc username'); const id = el('input', 'field'); id.id = 'idIn'; id.autocapitalize = 'none';
            const pinL = el('label', 'lbl', 'PIN'); const pin = el('input', 'field'); pin.id = 'pinIn'; pin.type = 'password'; pin.inputMode = 'numeric';
            const err = el('p', 'muted'); err.style.color = 'var(--over)'; err.style.minHeight = '1rem';
            const btn = el('button', 'btn', 'Sign in');
            btn.addEventListener('click', async function () {
                const identifier = id.value.trim(), p = pin.value.trim();
                if (!identifier || !p) { err.textContent = 'Enter your ID and PIN.'; return; }
                btn.disabled = true; err.textContent = '';
                const r = await api('/login', { method: 'POST', auth: false, guest: false, body: { identifier: identifier, pin: p } });
                btn.disabled = false;
                if (r.ok && r.data && r.data.token) { afterAuth(r.data); }
                else if (r.status === 423) { err.textContent = 'Too many attempts — try again in a few minutes.'; }
                else { err.textContent = r.status === 401 ? 'That ID/PIN didn’t match.' : 'Sign-in failed — try again.'; }
            });
            c.appendChild(idL); c.appendChild(id); c.appendChild(pinL); c.appendChild(pin); c.appendChild(err); c.appendChild(btn);
            if (passkeysSupported()) {
                const pkb = el('button', 'btn secondary', '🔑 Log in with a passkey');
                pkb.addEventListener('click', function () { loginWithPasskey(err, pkb); });
                c.appendChild(pkb);
                prefetchPasskey(); // warm the Worker + hold a challenge so the tap has no network before get()
            }
            if (GUEST_TOKEN) { const note = el('p', 'muted center', 'Registered as a guest? You can keep your card without signing in.'); const gb = el('button', 'btn ghost', 'Keep score as a guest'); gb.addEventListener('click', function () { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} boot(); }); c.appendChild(note); c.appendChild(gb); }
            const members = el('p', 'muted center return-members');
            const membersLink = el('a', 'link', 'Return to members');
            membersLink.href = 'gvdg-members.html';
            members.appendChild(membersLink);
            c.appendChild(members);
            shell(c);
        }

        function holeMeta(idx) { return S.holes[idx] || { hole: idx + 1, par: 3 }; }
        function renderLiveTeeSign(h) {
            const id = Number(h && h.tee_sign_id);
            if (!id) return null;
            const card = el('div', 'card tee-sign-card');
            // Matchplay: tint this hole's tee sign in the winning team's color. Halved holes stay as-is
            // (no color) in the scoring app, per spec.
            if (isMatchplayScoring() && window.GVDGMatchplay) {
                const w = window.GVDGMatchplay.holeWinners([{ hole: h.hole }], S.cardmates)[h.hole];
                const c = window.GVDGMatchplay.winnerColor(w, { tie: false });
                if (c) card.style.boxShadow = '0 0 0 3px ' + c;
            }
            const img = el('img');
            img.src = API_BASE + '/tee-signs/' + id + '/image';
            img.alt = 'Tee sign for hole ' + h.hole;
            img.loading = 'lazy';
            img.width = 640;
            img.height = 400;
            card.appendChild(img);
            const caption = el('div', 'tee-sign-caption');
            caption.appendChild(el('span', null, 'Tee sign'));
            caption.appendChild(el('span', null, 'Hole ' + h.hole));
            card.appendChild(caption);
            return card;
        }

        function roundWeatherNode() {
            if (!window.GVDGWeather) return null;
            // Best-effort: start the compass so the wind arrow tracks the player's facing. Android/desktop
            // sensors begin now; iOS needs a user gesture, so there it stays north-up until the arrow is tapped.
            if (S.weather && S.weather.current && window.GVDGWeather.enableCompass) window.GVDGWeather.enableCompass();
            return window.GVDGWeather.buildWeatherStrip(document, S.weather, { title: 'Round weather' });
        }
        // Swap the weather strip in place (no full renderHole) when a background refresh arrives, so the
        // scorecard's scroll position and any open scorer dropdown survive the 5-minute weather update.
        function refreshWeatherStrip() {
            const holder = document.querySelector('.weather-strip');
            if (!holder) return; // no strip rendered yet — the next renderHole will place it
            const fresh = roundWeatherNode();
            if (fresh) holder.replaceWith(fresh); else holder.remove();
        }
        function renderHole() {
            if (!S.holes.length) return;
            const h = holeMeta(S.holeIdx);
            document.getElementById('lbBtn').hidden = false;
            const c = el('div');
            const weatherNode = roundWeatherNode();
            if (weatherNode) c.appendChild(weatherNode);

            // Casual round: share the code + add walk-on players to the card.
            if (MODE === 'round') {
                const bar = el('div', 'card');
                bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:0.5rem;padding:0.55rem 0.85rem;';
                const left = el('div');
                left.appendChild(el('span', 'muted', 'Code '));
                const strong = document.createElement('strong'); strong.textContent = ROUND_CODE; strong.style.letterSpacing = '1.5px'; left.appendChild(strong);
                const actions = el('div'); actions.style.cssText = 'display:flex;gap:0.4rem;';
                const share = el('button', 'btn small secondary', 'Share'); share.addEventListener('click', shareRound);
                const add = el('button', 'btn small secondary', '+ Player'); add.addEventListener('click', addGuestPrompt);
                const manage = el('button', 'btn small secondary', 'Manage'); manage.addEventListener('click', openManagePlayers);
                actions.appendChild(share); actions.appendChild(add); actions.appendChild(manage);
                bar.appendChild(left); bar.appendChild(actions);
                c.appendChild(bar);
            }

            // hole header + nav
            const head = el('div', 'hole-head');
            const prev = el('button', 'navbtn', '‹'); prev.disabled = S.holeIdx === 0; prev.addEventListener('click', function () { S.holeIdx = Math.max(0, S.holeIdx - 1); renderHole(); });
            const mid = el('div'); mid.style.flex = '1'; mid.style.textAlign = 'center';
            mid.appendChild(el('div', 'hnum', 'Hole ' + h.hole));
            mid.appendChild(el('div', 'hpar', 'Par ' + h.par + (h.distance_ft ? ' · ' + h.distance_ft + ' ft' : '') + (h.overridden ? ' (today)' : '')));
            if (isMatchplayScoring()) {
                const status = matchStatusText();
                if (status) mid.appendChild(el('div', 'pmeta', status));
                if (isMatchDormie()) mid.appendChild(el('div', 'dormie-badge', '⚑ DORMIE — win or halve this hole to close it'));
            }
            const next = el('button', 'navbtn', '›'); next.disabled = S.holeIdx >= S.holes.length - 1; next.addEventListener('click', function () { S.holeIdx = Math.min(S.holes.length - 1, S.holeIdx + 1); renderHole(); });
            head.appendChild(prev); head.appendChild(mid); head.appendChild(next);
            c.appendChild(head);
            const teeSign = renderLiveTeeSign(h);
            if (teeSign) c.appendChild(teeSign);

            // player rows with steppers
            const box = el('div', 'card');
            const choices = scorecardChoices();
            const scorerIndex = currentScorerIndex();
            if (choices.length > 1) {
                const owner = el('div', 'scorecard-owner');
                owner.appendChild(el('label', null, 'Scorecard'));
                const select = document.createElement('select');
                choices.forEach((p) => {
                    const opt = document.createElement('option');
                    opt.value = String(p.index);
                    opt.textContent = p.name + (p.isMe ? ' (you)' : '');
                    select.appendChild(opt);
                });
                select.value = String(scorerIndex);
                select.addEventListener('change', function () { S.scorerIndex = Number(select.value); renderHole(); });
                owner.appendChild(select);
                box.appendChild(owner);
            }
            const rows = scoreRows();
            // My pair/card is broken (e.g. a partner left): show its exact message even if I still have rows
            // (the intact side of a broken matchplay match). Otherwise, if doubles has no rows yet, prompt to
            // set pairs. A healthy pair sharing a card with a broken one has scoreTargetError null → no banner.
            const warnMsg = (S.scoreTargetError && S.scoreTargetError.message) ? S.scoreTargetError.message
                : (isDoublesScoring() && !rows.length) ? 'Set pairs in Manage before scoring doubles.' : null;
            if (warnMsg) {
                const warn = el('p', 'muted', warnMsg);
                warn.style.color = 'var(--over)';
                box.appendChild(warn);
            }
            rows.forEach((rowData) => {
                const conflict = conflictForRow(rowData, h.hole);
                const row = el('div', 'prow' + (conflict ? ' conflict' : ''));
                const info = el('div', 'pinfo');
                info.appendChild(el('div', 'pname', rowData.label));
                if (rowData.meta) info.appendChild(el('div', 'pmeta', rowData.meta));
                if (conflict) info.appendChild(el('div', 'pmeta conflict-text', '⚑ Conflict: ' + (conflict.values || []).join(' vs ') + ' — set yours to match'));
                const cur = strokesForRow(rowData, h.hole);
                const step = el('div', 'stepper');
                const minus = el('button', 'minus', '−');
                const val = el('div', 'val');
                const n = el('div', 'n', cur == null ? '–' : String(cur)); val.appendChild(n);
                if (cur != null) { const d = cur - h.par; const rel = el('div', 'rel ' + relClass(d), relText(d)); val.appendChild(rel); }
                const plus = el('button', 'plus', '+');
                minus.addEventListener('click', function () { const base = cur == null ? h.par : cur; const nv = Math.max(1, base - 1); postScore(rowData, h.hole, nv); });
                plus.addEventListener('click', function () { const base = cur == null ? h.par - 1 : cur; const nv = Math.min(30, base + 1); postScore(rowData, h.hole, nv); });
                step.appendChild(minus); step.appendChild(val); step.appendChild(plus);
                row.appendChild(info); row.appendChild(step);
                box.appendChild(row);
            });

            // my totals
            const meRow = myScoreRow();
            if (meRow) {
                let thru = 0, total = 0, toPar = 0;
                S.holes.forEach((hh) => { const s = strokesForRow(meRow, hh.hole); if (typeof s === 'number') { thru++; total += s; toPar += s - hh.par; } });
                const tot = el('div', 'totbar');
                const resultLabel = isMatchplayScoring() ? 'Match' : 'To par';
                const resultValue = isMatchplayScoring() ? (matchStatusText().replace(/^Match: /, '') || 'AS') : (thru ? relText(toPar) : 'E');
                [['Thru', String(thru) + '/' + S.holes.length], ['Total', total ? String(total) : '–'], [resultLabel, resultValue]].forEach((kv) => {
                    const d = el('div'); d.appendChild(el('div', 'k', kv[0])); d.appendChild(el('div', 'v', kv[1])); tot.appendChild(d);
                });
                box.appendChild(tot);
            }
            c.appendChild(box);

            // hole jump grid
            const grid = el('div', 'holegrid');
            S.holes.forEach((hh, i) => {
                const b = el('button', i === S.holeIdx ? 'cur' : '', String(hh.hole));
                if (meRow && strokesForRow(meRow, hh.hole) != null) b.className += ' done';
                if (holeHasConflict(hh.hole)) b.className += ' conflict';
                b.addEventListener('click', function () { S.holeIdx = i; renderHole(); });
                grid.appendChild(b);
            });
            c.appendChild(grid);

            shell(c);
        }

        // ---------- leaderboard sheet ----------
        let lbOpen = false, lbSheet = null;
        document.getElementById('lbBtn').addEventListener('click', openLeaderboard);
        function openLeaderboard() { lbOpen = true; renderLeaderboard(); }
        function closeLeaderboard() { lbOpen = false; if (lbSheet) { lbSheet.remove(); lbSheet = null; } }
        function renderLeaderboard() {
            if (lbSheet) lbSheet.remove();
            const overlay = el('div', 'overlay'); overlay.addEventListener('click', function (e) { if (e.target === overlay) closeLeaderboard(); });
            const sheet = el('div', 'sheet'); sheet.appendChild(el('div', 'grab'));
            sheet.appendChild(el('h2', 'section', 'Live Leaderboard'));
            const standings = (S.snap && S.snap.standings) || [];
            if (!standings.length) { sheet.appendChild(el('p', 'muted', 'No scores in yet.')); }
            else {
                const table = el('table', 'lb');
                const resultHead = isMatchplayScoring() ? 'Match' : 'To par';
                const thead = el('tr'); ['', isDoublesScoring() ? 'Pair' : 'Player', 'Thru', resultHead].forEach((t) => thead.appendChild(el('th', null, t))); table.appendChild(thead);
                standings.forEach((s, i) => {
                    const tr = el('tr');
                    tr.appendChild(el('td', 'pos', String(i + 1)));
                    const name = s.name + (s.members && s.members.length ? ' · ' + s.members.join(' / ') : (s.division ? ' · ' + s.division : ''));
                    tr.appendChild(el('td', 'name', name));
                    tr.appendChild(el('td', null, (s.thru || 0) + ''));
                    if (isMatchplayScoring()) tr.appendChild(el('td', null, s.match && s.match.status ? s.match.status : 'AS'));
                    else tr.appendChild(el('td', 'tp ' + relClass(s.toPar || 0), s.thru ? relText(s.toPar || 0) : 'E'));
                    table.appendChild(tr);
                });
                sheet.appendChild(table);
            }
            // "Add to UDisc": the caller's own hole-by-hole scores → open the right UDisc course to tap
            // in (UDisc has no import API). Casual rounds aren't written to D1, so we source the scorecard
            // live from this card. Shown only when the course's numeric UDisc id is known.
            if (window.UDiscExport && S.udiscCourseId) {
                const me = (S.cardmates || []).find((c) => c.isMe);
                if (me && me.scores) {
                    const card = S.holes.filter((h) => me.scores[h.hole] != null).map((h) => ({ hole: h.hole, par: h.par, strokes: me.scores[h.hole] }));
                    const node = window.UDiscExport.build({ courseId: S.udiscCourseId, scorecard: card });
                    if (node) { node.style.marginTop = '1rem'; sheet.appendChild(node); }
                }
            }
            // ---- finalize status + action ----
            if (S.status === 'final') {
                const done = el('div'); done.style.cssText = 'margin-top:1rem;padding:0.8rem;border-radius:12px;border:1px solid var(--under);background:var(--bg-primary)';
                done.appendChild(el('p', null, '🏁 Round finished — scores are locked.')).style.cssText = 'font-weight:700;color:var(--under)';
                sheet.appendChild(done);
            } else {
                const bl = finalizeBlockers();
                const box = el('div'); box.style.cssText = 'margin-top:1rem;padding:0.8rem;border-radius:12px;border:1px solid var(--border-color);background:var(--bg-primary)';
                const head = el('p', null, bl.ready ? '✓ Your card agrees — ready to finalize' : '⚑ Your card isn’t ready yet');
                head.style.cssText = 'font-weight:700;margin-bottom:0.2rem;color:' + (bl.ready ? 'var(--under)' : 'var(--over)');
                box.appendChild(head);
                bl.lines.forEach((line) => { const p = el('p', 'muted', line); p.style.fontSize = '0.82rem'; box.appendChild(p); });
                sheet.appendChild(box);
                // Casual rounds are finished from here by any member on the card. Competition rounds are
                // finalized by an admin from the admin console, so players only see the status above.
                if (MODE === 'round') {
                    const fin = el('button', 'btn', '🏁 Finish round'); fin.style.marginTop = '0.7rem';
                    fin.disabled = !bl.ready;
                    fin.addEventListener('click', finalizeRound);
                    sheet.appendChild(fin);
                    if (!bl.ready) { const hint = el('p', 'muted', 'Every member on the card must enter matching scores for every hole before the round can be finished.'); hint.style.cssText = 'font-size:0.8rem;margin-top:0.4rem'; sheet.appendChild(hint); }
                }
            }
            const close = el('button', 'btn secondary', 'Close'); close.style.marginTop = '1rem'; close.addEventListener('click', closeLeaderboard);
            sheet.appendChild(close);
            overlay.appendChild(sheet); document.body.appendChild(overlay); lbSheet = overlay;
        }
        // What (if anything) is stopping this card from finalizing: unresolved conflicts + unconfirmed
        // member scores. Recomputed each render so the sheet reflects live snapshots while it's open.
        function finalizeBlockers() {
            const conflicts = S.conflicts || [];
            const missing = S.missing || [];
            const lines = [];
            conflicts.forEach((c) => lines.push('Hole ' + c.hole + ' — ' + (c.playerName || c.label || 'a target') + ': scores disagree (' + (Array.isArray(c.values) ? c.values.join(' vs ') : '?') + ')'));
            const shown = missing.slice(0, 4);
            shown.forEach((m) => lines.push('Hole ' + m.hole + ' — ' + (m.playerName || m.label || 'a target') + ': not confirmed by all members'));
            if (missing.length > shown.length) lines.push('…and ' + (missing.length - shown.length) + ' more unconfirmed');
            return { conflicts: conflicts, missing: missing, ready: conflicts.length === 0 && missing.length === 0, lines: lines };
        }
        async function finalizeRound() {
            if (!confirm('Finish this round? This locks the scorecard for everyone.')) return;
            // Casual finalize is /rounds/<code>/finalize (NOT under /live). The Finish button only shows
            // for casual rounds; competition rounds are finalized by an admin from the admin console.
            const r = await api('/rounds/' + ROUND_CODE + '/finalize', { method: 'POST', body: {} });
            if (r.ok && r.data && r.data.status === 'final') {
                S.status = 'final';
                toast('Round finished 🏁');
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
            S.scorerIndex = d.playerIndex;
            if (MODE === 'round') rememberRecentRound({ code: ROUND_CODE, label: 'Casual round ' + ROUND_CODE });
            currentScorerIndex();
            setConflicts(d.conflicts);
            setMissing(d.missing);
            // start on the card's shotgun hole if set, else hole 1
            const me = d.cardmates.find((p) => p.isMe);
            const sh = me && me.startingHole;
            const startIdx = sh ? S.holes.findIndex((h) => h.hole === sh) : 0;
            S.holeIdx = startIdx >= 0 ? startIdx : 0;
            document.getElementById('barTitle').firstChild.textContent = MODE === 'round' ? ('Round ' + ROUND_CODE) : ('Card ' + (S.cardId || ''));
            const subEl = document.getElementById('barSub'); if (subEl) subEl.textContent = [S.courseName, S.layoutName].filter(Boolean).join(' · ') || 'Greenville Disc Golf Club';
            renderHole();
            connectWs();
            flushQueue();
        }

        // ---- casual round: home, course/layout pickers, create, add guest ----
        function spinner() { return (function () { const d = el('div', 'center'); d.appendChild(el('div', 'spin')); return d; })(); }
        function renderHome() {
            const c = el('div', 'stack');
            const h = el('div', 'card stack');
            h.appendChild(el('h2', 'section', 'Keep score'));
            h.appendChild(el('p', 'muted', 'Start a casual round and share the code with your card, or join a round someone already started.'));
            const start = el('button', 'btn', '⛳ Start a casual round'); start.addEventListener('click', renderCoursePick);
            h.appendChild(start);
            h.appendChild(el('label', 'lbl', 'Join with a code'));
            const ji = el('input', 'field'); ji.placeholder = 'e.g. K7M2QX'; ji.autocapitalize = 'characters'; ji.maxLength = 8;
            const jb = el('button', 'btn secondary', 'Join round');
            jb.addEventListener('click', function () { const code = (ji.value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (code.length >= 4) location.search = '?round=' + code; else toast('Enter a valid code'); });
            h.appendChild(ji); h.appendChild(jb);
            c.appendChild(h);
            const out = el('button', 'btn ghost', 'Sign out'); out.addEventListener('click', function () { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} renderLogin(); });
            c.appendChild(out);
            shell(c);
        }
        async function renderCoursePick() {
            shell(spinner());
            const r = await api('/courses', { auth: false });
            const courses = (r.ok && r.data && r.data.courses) || [];
            const c = el('div', 'stack');
            const back = el('button', 'btn ghost small', '‹ Back'); back.addEventListener('click', renderHome); c.appendChild(back);
            c.appendChild(el('h2', 'section', 'Pick a course'));
            if (!courses.length) c.appendChild(el('p', 'muted', 'No courses found.'));
            courses.forEach(function (co) {
                const row = el('button', 'tap-row'); const g = el('div', 'grow');
                g.appendChild(el('div', 'title', co.name)); if (co.location) g.appendChild(el('div', 'sub', co.location));
                row.appendChild(g); row.appendChild(el('div', 'chev', '›'));
                row.addEventListener('click', function () { renderLayoutPick(co); });
                c.appendChild(row);
            });
            shell(c);
        }
        async function renderLayoutPick(course) {
            shell(spinner());
            const r = await api('/courses/' + encodeURIComponent(course.id) + '/layouts', { auth: false });
            const layouts = (r.ok && r.data && r.data.layouts) || [];
            const c = el('div', 'stack');
            const back = el('button', 'btn ghost small', '‹ Back'); back.addEventListener('click', renderCoursePick); c.appendChild(back);
            c.appendChild(el('h2', 'section', course.name));
            if (!layouts.length) c.appendChild(el('p', 'muted', 'This course has no scorable layouts yet — an admin can add one (Admin → Layouts, or import from UDisc).'));
            layouts.forEach(function (L) {
                const row = el('button', 'tap-row'); const g = el('div', 'grow');
                g.appendChild(el('div', 'title', L.name || 'Layout')); g.appendChild(el('div', 'sub', L.total_par != null ? ('Par ' + L.total_par) : ''));
                row.appendChild(g); row.appendChild(el('div', 'chev', '›'));
                row.addEventListener('click', function () { renderSetupPick(course, L); });
                c.appendChild(row);
            });
            shell(c);
        }
        function defaultLiveScoringConfig() {
            return { groupFormat: 'singles', scoringStyle: 'stroke' };
        }
        function renderSetupPick(course, layout) {
            const selected = defaultLiveScoringConfig();
            const c = el('div', 'stack');
            const back = el('button', 'btn ghost small', '‹ Back'); back.addEventListener('click', function () { renderLayoutPick(course); }); c.appendChild(back);
            const intro = el('div', 'card stack');
            intro.setAttribute('data-score-setup', 'casual-format');
            intro.appendChild(el('span', 'pill', layout && layout.name ? layout.name : 'Layout'));
            intro.appendChild(el('h2', 'section', 'Round setup'));
            intro.appendChild(el('p', 'muted', 'Choose how this casual card is scored. Defaults are ready for a standard singles stroke round.'));
            c.appendChild(intro);

            const optionGroups = [
                {
                    key: 'groupFormat',
                    label: 'Group format',
                    attr: 'data-group-format',
                    options: [
                        { value: 'singles', title: 'Singles', sub: 'One score per player' },
                        { value: 'doubles', title: 'Doubles', sub: 'One score per pair' }
                    ]
                },
                {
                    key: 'scoringStyle',
                    label: 'Scoring style',
                    attr: 'data-scoring-style',
                    options: [
                        { value: 'stroke', title: 'Stroke play', sub: 'Lowest total wins' },
                        { value: 'matchplay', title: 'Match play', sub: 'Win holes head to head' }
                    ]
                }
            ];
            const buttons = [];
            function refresh() {
                buttons.forEach(function (btn) {
                    btn.setAttribute('aria-pressed', selected[btn.dataset.setupKey] === btn.dataset.setupValue ? 'true' : 'false');
                });
            }
            optionGroups.forEach(function (group) {
                const card = el('div', 'card stack');
                card.appendChild(el('label', 'lbl', group.label));
                const grid = el('div', 'setup-grid');
                group.options.forEach(function (opt) {
                    const btn = el('button', 'setup-option');
                    btn.type = 'button';
                    btn.dataset.setupKey = group.key;
                    btn.dataset.setupValue = opt.value;
                    btn.setAttribute(group.attr, opt.value);
                    btn.appendChild(el('span', 'title', opt.title));
                    btn.appendChild(el('span', 'sub', opt.sub));
                    btn.addEventListener('click', function () { selected[group.key] = opt.value; refresh(); });
                    buttons.push(btn);
                    grid.appendChild(btn);
                });
                card.appendChild(grid);
                c.appendChild(card);
            });
            const start = el('button', 'btn', 'Start round');
            start.setAttribute('data-create-round', 'casual');
            start.addEventListener('click', function () { createRound(course, layout, selected); });
            c.appendChild(start);
            refresh();
            shell(c);
        }
        async function createRound(course, layout, config) {
            shell(spinner());
            const liveScoringConfig = config || defaultLiveScoringConfig();
            const r = await api('/rounds', { method: 'POST', body: { course_id: course.id, layout_id: layout.id, liveScoringConfig: { groupFormat: liveScoringConfig.groupFormat, scoringStyle: liveScoringConfig.scoringStyle } } });
            if (r.ok && r.data && r.data.code) { location.search = '?round=' + r.data.code; return; }
            renderMessage('Could not start round', (r.data && r.data.error === 'no_layout_holes') ? 'That layout has no holes/pars yet.' : 'Please try again.', false);
        }
        async function addGuestPrompt() {
            const name = (window.prompt('Add a player to your card (their name):') || '').trim();
            if (!name) return;
            // Doubles requires a pair label per player — collect it now so the walk-on is pairable, rather
            // than leaving the round unscorable until someone opens Manage players.
            let team = null;
            if (isDoublesScoring()) {
                team = (window.prompt('Pair label for ' + name + ' (doubles — use the SAME label for their partner):') || '').trim();
                if (!team) { toast('Doubles needs a pair label for each player'); return; }
            }
            const r = await api('/rounds/' + ROUND_CODE + '/guest', { method: 'POST', body: team ? { name: name, team: team } : { name: name } });
            if (r.ok && r.data && Array.isArray(r.data.cardmates)) { S.cardmates = r.data.cardmates; currentScorerIndex(); renderHole(); toast(name + ' added'); }
            else toast('Could not add player');
        }
        // Manage players: remove someone who joined by accident, had to leave, or no-showed (casual round).
        function openManagePlayers() {
            const overlay = el('div', 'overlay'); overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
            const sheet = el('div', 'sheet'); sheet.appendChild(el('div', 'grab'));
            sheet.appendChild(el('h2', 'section', 'Players'));
            sheet.appendChild(el('p', 'muted', 'Remove a player who registered by accident, had to leave, or didn’t show. Their scores are cleared.'));
            const pairInputs = [];
            if (isDoublesScoring()) {
                const pairBox = el('div', 'card stack');
                pairBox.style.margin = '0.75rem 0';
                pairBox.appendChild(el('label', 'lbl', 'Doubles pairs'));
                pairBox.appendChild(el('p', 'muted', 'Use the same pair label for exactly two active players before scoring starts.'));
                (S.cardmates || []).forEach(function (p) {
                    const wrap = el('label', 'lbl');
                    wrap.textContent = p.name + (p.isMe ? ' (you)' : '');
                    const input = el('input', 'field');
                    input.maxLength = 40;
                    input.value = p.team || '';
                    input.placeholder = 'Pair label';
                    wrap.appendChild(input);
                    pairInputs.push({ player: p, input: input });
                    pairBox.appendChild(wrap);
                });
                const savePairs = el('button', 'btn small secondary', 'Save pairs');
                savePairs.addEventListener('click', function () { savePairLabels(pairInputs, overlay); });
                pairBox.appendChild(savePairs);
                sheet.appendChild(pairBox);
            }
            (S.cardmates || []).forEach(function (p) {
                const row = el('div', 'prow');
                row.appendChild(el('div', 'pname', p.name + (p.isMe ? ' (you)' : '')));
                const rm = el('button', 'btn small ghost', p.isMe ? 'Leave round' : 'Remove');
                rm.addEventListener('click', function () { removeFromRound(p, overlay); });
                row.appendChild(rm);
                sheet.appendChild(row);
            });
            const close = el('button', 'btn secondary', 'Close'); close.style.marginTop = '1rem'; close.addEventListener('click', function () { overlay.remove(); });
            sheet.appendChild(close);
            overlay.appendChild(sheet); document.body.appendChild(overlay);
        }
        async function savePairLabels(pairInputs, overlay) {
            const assignments = pairInputs.map(function (item) { return { index: item.player.index, pairLabel: item.input.value.trim() }; });
            const r = await api('/rounds/' + ROUND_CODE + '/pairs', { method: 'POST', body: { assignments: assignments } });
            if (!r.ok) {
                if (r.status === 409) toast(r.data && r.data.error === 'scores_exist' ? 'Pair changes are blocked after scoring starts' : 'Could not save pairs');
                else if (r.status === 400 && r.data && r.data.message) toast(r.data.message);
                else toast('Could not save pairs');
                return;
            }
            if (overlay) overlay.remove();
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
        async function removeFromRound(p, overlay) {
            const msg = p.isMe ? 'Leave this round? Your scores will be cleared.' : ('Remove ' + p.name + ' from this round? Their scores will be cleared.');
            if (!window.confirm(msg)) return;
            const r = await api('/rounds/' + ROUND_CODE + '/remove', { method: 'POST', body: { index: p.index, name: p.name } });
            if (overlay) overlay.remove();
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

        async function boot() {
            setOnline(navigator.onLine);
            if (MODE === 'home') { if (!memberToken()) { renderLogin(); return; } renderHome(); return; }
            if (!memberToken() && !GUEST_TOKEN) { renderLogin(); return; }
            shell(spinner());
            await loadMine();
        }
        boot();
}
