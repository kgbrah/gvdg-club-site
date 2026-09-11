export function dollarsFromCents(cents) {
  const n = Number(cents || 0);
  const abs = Math.abs(n);
  const out = "$" + (abs / 100).toLocaleString(undefined, { minimumFractionDigits: abs % 100 ? 2 : 0 });
  return n < 0 ? "-" + out : out;
}

export function normalizeCtp(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const hole = Number(source.hole);
  return {
    division: typeof source.division === "string" ? source.division : "",
    hole: Number.isInteger(hole) ? hole : null,
    id: source.id == null ? "" : String(source.id),
    prize: typeof source.prize === "string" ? source.prize : "",
    winnerName: typeof source.winner_name === "string" ? source.winner_name : "",
  };
}

export function normalizeAcePot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const status = typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : "active";
  const totalCents = Number(raw.total_cents) || 0;
  return {
    contributors: Number(raw.contributors) || 0,
    status,
    totalCents,
    visible: totalCents > 0 || (status !== "active"),
    winnerName: typeof raw.winner_name === "string" ? raw.winner_name : "",
  };
}

export function acePotLine(pot) {
  if (!pot || !pot.visible) return "";
  if (pot.status === "paid_out") return "Paid out" + (pot.winnerName ? " to " + pot.winnerName : "");
  if (pot.status === "carried") return dollarsFromCents(pot.totalCents) + " carried to the next event";
  const inCount = pot.contributors ? " (" + pot.contributors + " in)" : "";
  return dollarsFromCents(pot.totalCents) + " in the pot" + inCount;
}

export function ctpLine(ctp) {
  const parts = ["Hole " + (ctp.hole ?? "?")];
  if (ctp.division) parts.push(ctp.division);
  if (ctp.prize) parts.push(ctp.prize);
  if (ctp.winnerName) parts.push("Winner: " + ctp.winnerName);
  return parts.join(" · ");
}

export function buildLivePots({ acePot = null, ctps = [], currentHole = null } = {}) {
  const list = (Array.isArray(ctps) ? ctps : []).map(normalizeCtp).filter((ctp) => ctp.hole != null);
  const ace = normalizeAcePot(acePot);
  const hole = Number(currentHole);
  return {
    ace,
    aceLine: acePotLine(ace),
    ctps: list,
    currentHoleCtps: list.filter((ctp) => ctp.hole === hole),
    holeNumbers: list.map((ctp) => ctp.hole),
    visible: list.length > 0 || Boolean(ace && ace.visible),
  };
}

export function aceHint({ hole, pots, scores } = {}) {
  if (!pots || !pots.ace || !pots.ace.visible || pots.ace.status !== "active") return "";
  const hasAce = (Array.isArray(scores) ? scores : []).some((value) => Number(value) === 1);
  if (!hasAce) return "";
  const holeNum = Number(hole);
  const where = Number.isInteger(holeNum) ? " hole " + holeNum : " this hole";
  return "Ace on" + where + ". Pot is " + dollarsFromCents(pots.ace.totalCents) + " — an admin records the winner.";
}
