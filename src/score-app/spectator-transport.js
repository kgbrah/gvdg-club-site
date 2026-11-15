const HEARTBEAT_MS = 10_000;
const STALE_MS = 25_000;
const FINAL_CHECK_MS = 20_000;

export function spectatorBackoff(attempt, random = Math.random) {
  const base = Math.min(24_000, 1_000 * 2 ** Math.min(5, Math.max(0, attempt)));
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** A delayed HTTP response must not replace a more recent socket frame. */
export function acceptSpectatorSnapshot(current, incoming, startedWith = current) {
  if (!incoming || (incoming.status !== "live" && incoming.status !== "final")) return false;
  if (!current) return true;
  const sameRound = (current.recoveryRoundId ?? null) === (incoming.recoveryRoundId ?? null);
  if (!sameRound) return current === startedWith;
  if (current.status === "final" && incoming.status !== "final") return false;
  if (incoming.archived && !current.archived && current.status === "final") return false;
  if (incoming.status === "final" && current.status !== "final") return true;
  const a = Number(current.rev ?? -1);
  const b = Number(incoming.rev ?? -1);
  if (a !== b) return b > a;
  if (current !== startedWith && !incoming.observedAt) return false;
  return Number(incoming.observedAt ?? 0) >= Number(current.observedAt ?? 0);
}

export function spectatorUpdateAge(value, now = Date.now()) {
  if (value == null || value === "") return "";
  const iso = typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(" ", "T") + "Z" : value;
  const at = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return seconds + " sec ago";
  if (seconds < 3_600) return Math.floor(seconds / 60) + " min ago";
  if (seconds < 86_400) return Math.floor(seconds / 3_600) + " hr ago";
  return Math.floor(seconds / 86_400) + " days ago";
}

export function createSpectatorTransport({
  fetchSnapshot, openSocket, onState, online = () => navigator.onLine,
  now = Date.now, random = Math.random, timers = globalThis,
}) {
  let socket = null;
  let snapshot = null;
  let phase = "connecting";
  let lastContact = 0;
  let receivedAt = 0;
  let running = false;
  let attempt = 0;
  let generation = 0;
  let retry = null;
  let watchdog = null;
  let disconnectedAt = 0;
  let tickId = null;

  function emit() {
    onState({ phase, snapshot, receivedAt });
  }

  function closeSocket() {
    const previous = socket;
    socket = null;
    if (previous) previous.close();
    timers.clearTimeout(watchdog);
  }

  function schedule(time, fn) {
    timers.clearTimeout(retry);
    retry = timers.setTimeout(fn, time);
  }

  function deny() {
    generation += 1;
    closeSocket();
    timers.clearTimeout(retry);
    snapshot = null;
    phase = "unavailable";
    emit();
  }

  function apply(next, startedWith = snapshot) {
    if (!acceptSpectatorSnapshot(snapshot, next, startedWith)) return;
    snapshot = next;
    receivedAt = now();
    if (next.status === "final") {
      phase = "final";
      closeSocket();
      schedule(FINAL_CHECK_MS, () => { void refresh(generation, false); });
    }
    emit();
  }

  async function refresh(run, initial) {
    const startedWith = snapshot;
    let result;
    try { result = await fetchSnapshot(); } catch { result = { status: 0 }; }
    if (!running || run !== generation) return;
    if (result.status === 401 || result.status === 403 || result.status === 404) {
      deny();
      return;
    }
    if (result.snapshot) apply(result.snapshot, startedWith);
    else if (result.status === 200 && !snapshot) {
      deny();
      return;
    }
    if (snapshot?.status === "final") {
      if (!result.snapshot && phase === "final") {
        phase = "stale";
        emit();
      } else if (result.snapshot && phase === "stale") {
        phase = "final";
        emit();
      }
      schedule(FINAL_CHECK_MS, () => { void refresh(generation, false); });
      return;
    }
    if (initial && running && run === generation && phase !== "unavailable") connect(run);
  }

  function reconnect() {
    if (!running || phase === "unavailable" || snapshot?.status === "final") return;
    closeSocket();
    const run = ++generation;
    disconnectedAt ||= now();
    phase = !online() || now() - disconnectedAt >= STALE_MS ? "stale" : (snapshot || attempt ? "reconnecting" : "connecting");
    emit();
    if (online()) {
      // A fresh HTTP snapshot restores scores even if upgrading the socket keeps failing.
      void refresh(run, true);
    }
  }

  function connectionLost(activeSocket, revoked) {
    if (socket !== activeSocket) return;
    closeSocket();
    disconnectedAt ||= lastContact || now();
    const run = ++generation;
    if (revoked) {
      // Drop the watch display while the updated access policy is fetched.
      snapshot = null;
      phase = "connecting";
      emit();
      void refresh(run, true);
      return;
    }
    phase = online() && now() - disconnectedAt < STALE_MS ? "reconnecting" : "stale";
    emit();
    if (online()) schedule(spectatorBackoff(attempt++, random), reconnect);
  }

  function connect(run) {
    if (!online() || socket || run !== generation) return;
    let active;
    try { active = openSocket(); } catch {
      phase = "reconnecting";
      emit();
      schedule(spectatorBackoff(attempt++, random), reconnect);
      return;
    }
    socket = active;
    lastContact = now();
    active.addEventListener("open", () => {
      if (socket !== active || run !== generation) return;
      lastContact = now();
      // Recover revisions sent before the upgrade completed.
      void refresh(run, false);
    });
    active.addEventListener("message", (event) => {
      if (socket !== active || run !== generation) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || (message.type !== "snapshot" && message.type !== "pong")) return;
      lastContact = now();
      if (message.type === "pong") return;
      if (message.status === "none") {
        deny();
        return;
      }
      const previousPhase = phase;
      const previous = snapshot;
      if (message.status === "live") {
        phase = "live";
        attempt = 0;
        disconnectedAt = 0;
        timers.clearTimeout(watchdog);
      }
      apply(message);
      // A rejected revision can still establish that the socket is delivering.
      if (snapshot === previous && phase !== previousPhase) emit();
    });
    active.addEventListener("close", (event) => connectionLost(active, event.code === 4403));
    active.addEventListener("error", () => connectionLost(active, false));
    watchdog = timers.setTimeout(() => connectionLost(active, false), STALE_MS);
  }

  function tick() {
    if (!running || phase === "unavailable") return;
    if (socket && now() - lastContact >= STALE_MS) connectionLost(socket, false);
    if (socket?.readyState === 1) {
      try { socket.send("ping"); } catch { connectionLost(socket, false); }
    }
    if (disconnectedAt && now() - disconnectedAt >= STALE_MS && snapshot?.status !== "final" && phase !== "live") {
      phase = "stale";
      emit();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      tickId = timers.setInterval(tick, HEARTBEAT_MS);
      reconnect();
    },
    resume() {
      if (!running || phase === "unavailable") return;
      if (snapshot?.status === "final") { void refresh(generation, false); return; }
      if (!socket || now() - lastContact >= STALE_MS) {
        timers.clearTimeout(retry);
        reconnect();
      }
    },
    offline() {
      if (!running || phase === "unavailable") return;
      generation += 1;
      closeSocket();
      timers.clearTimeout(retry);
      phase = "stale";
      emit();
    },
    checkIdentity() {
      if (!running) return;
      snapshot = null;
      phase = "connecting";
      timers.clearTimeout(retry);
      reconnect();
    },
    retry() {
      if (snapshot?.status === "final") { void refresh(generation, false); return; }
      phase = "connecting";
      timers.clearTimeout(retry);
      reconnect();
    },
    stop() {
      running = false;
      generation += 1;
      closeSocket();
      timers.clearTimeout(retry);
      timers.clearInterval(tickId);
    },
  };
}
