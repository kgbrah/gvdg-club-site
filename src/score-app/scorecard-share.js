import { isMatchplayScoring, matchStatusText, relText, scoreRows, strokesForRow } from "./score-view-model.js";

const EASTERN = "America/New_York";
export const SHARE_CARD_WIDTH = 1080;

const INK = "#1A1A2E";
const PANEL = "#252538";
const LINE = "#2A2A3E";
const LIGHT = "#F4F4F9";
const MUTED = "#A0A0A0";
const ORANGE = "#FF6B35";
const GOLD = "#F7B801";
const UNDER = "#4FD37E";
const OVER = "#FF7A5C";

const PAD = 56;
const NAME_W = 214;
const TOT_W = 90;
const REL_W = 88;
const HEADER_H = 248;
const BANK_HEAD = 84;
const ROW_H = 64;
const BANK_GAP = 32;
const FOOTER_H = 96;
const MIN_HEIGHT = 1350;

function displayName(label) {
  return String(label || "").replace(/\s+\(you\)$/i, "").trim() || "Player";
}

export function shareCardDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date();
  return {
    display: new Intl.DateTimeFormat("en-US", {
      timeZone: EASTERN,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date),
    iso: new Intl.DateTimeFormat("en-CA", {
      timeZone: EASTERN,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date),
  };
}

export function buildShareCard(state, options = {}) {
  const scorerIndex = options.scorerIndex ?? (state && state.scorerIndex) ?? (state && state.myIndex);
  const holes = Array.isArray(state && state.holes) ? state.holes : [];
  const rows = scoreRows(state || {});
  const players = rows.map((row) => {
    const scores = holes.map((hole) => strokesForRow(state, row, hole.hole, scorerIndex));
    let total = 0;
    let toPar = 0;
    let thru = 0;
    scores.forEach((strokes, index) => {
      if (typeof strokes !== "number") return;
      thru += 1;
      total += strokes;
      toPar += strokes - (typeof holes[index].par === "number" ? holes[index].par : 0);
    });
    return {
      label: displayName(row.label),
      scores,
      thru,
      total: thru ? total : null,
      toPar: thru ? toPar : null,
    };
  });
  const when = shareCardDate(options.now);
  const matchplay = isMatchplayScoring(state || {});
  return {
    club: "Greenville Disc Golf Club",
    mark: "GVDG",
    course: String((state && state.courseName) || "").trim() || "Disc golf",
    layout: String((state && state.layoutName) || "").trim(),
    date: when.display,
    dateIso: when.iso,
    roundCode: String(options.roundCode || "").trim(),
    matchplay,
    matchStatus: matchplay ? String(matchStatusText(state || {}) || "").replace(/^Match:\s*/, "") : "",
    holes: holes.map((hole) => hole.hole),
    pars: holes.map((hole) => hole.par),
    players,
    scored: players.some((player) => player.thru > 0),
    footer: "gvdgclub.com",
  };
}

export function shareCardFileName(model) {
  const slug = String((model && model.course) || "round")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "round";
  const day = String((model && model.dateIso) || "card").slice(0, 10);
  return "gvdg-" + slug + "-" + day + ".png";
}

export function shareCardText(model, url) {
  const card = model || {};
  const bits = [card.course, card.layout, card.date].filter(Boolean);
  const lead = bits.length ? bits.join(" · ") : "GVDG round";
  const code = card.roundCode ? "Join my card — code " + card.roundCode : "Watch live on GVDG";
  return lead + "\n" + code + (url ? "\n" + url : "");
}

export function shareCardSize(model) {
  const holes = (model && model.holes) || [];
  const players = Math.max(1, ((model && model.players) || []).length);
  const banks = Math.max(1, Math.ceil(holes.length / 9) || 1);
  const height = HEADER_H + banks * (BANK_HEAD + players * ROW_H) + Math.max(0, banks - 1) * BANK_GAP + FOOTER_H;
  return { width: SHARE_CARD_WIDTH, height: Math.max(MIN_HEIGHT, height) };
}

function scoreColor(strokes, par) {
  if (typeof strokes !== "number") return MUTED;
  const delta = strokes - (typeof par === "number" ? par : 0);
  if (delta < 0) return UNDER;
  if (delta > 0) return OVER;
  return LIGHT;
}

function relColor(toPar) {
  if (toPar == null) return MUTED;
  if (toPar < 0) return UNDER;
  if (toPar > 0) return OVER;
  return LIGHT;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function ellipsize(ctx, text, maxWidth) {
  const value = String(text || "");
  if (ctx.measureText(value).width <= maxWidth) return value;
  let next = value;
  while (next.length > 1 && ctx.measureText(next + "…").width > maxWidth) next = next.slice(0, -1);
  return next + "…";
}

function holeBanks(model) {
  const holes = model.holes || [];
  const banks = [];
  for (let start = 0; start < Math.max(holes.length, 1); start += 9) {
    banks.push({ start, count: Math.min(9, Math.max(holes.length - start, 0)) });
    if (start + 9 >= holes.length) break;
  }
  return banks;
}

export function drawShareCard(ctx, model, size) {
  const card = model || {};
  const { width, height } = size || shareCardSize(card);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, width, height);

  roundRect(ctx, 36, 36, width - 72, height - 72, 36);
  ctx.fillStyle = PANEL;
  ctx.fill();
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = ORANGE;
  ctx.font = "800 42px Archivo, system-ui, sans-serif";
  ctx.fillText(card.mark || "GVDG", PAD, 108);
  ctx.fillStyle = GOLD;
  ctx.font = "700 22px Archivo, system-ui, sans-serif";
  ctx.fillText(card.club || "Greenville Disc Golf Club", PAD, 140);

  ctx.fillStyle = LIGHT;
  ctx.font = "800 54px Archivo, system-ui, sans-serif";
  ctx.fillText(ellipsize(ctx, card.course || "Disc golf", width - PAD * 2), PAD, 208);

  const meta = [card.layout, card.date, card.roundCode ? "Round " + card.roundCode : ""]
    .filter(Boolean)
    .join("  ·  ");
  ctx.fillStyle = MUTED;
  ctx.font = "700 24px Archivo, system-ui, sans-serif";
  ctx.fillText(ellipsize(ctx, meta, width - PAD * 2), PAD, 244);
  if (card.matchplay && card.matchStatus) {
    ctx.fillStyle = GOLD;
    ctx.fillText(card.matchStatus, PAD, 276);
  }

  const players = card.players || [];
  const innerW = width - PAD * 2 - NAME_W - TOT_W - REL_W;
  let y = card.matchplay && card.matchStatus ? HEADER_H + 20 : HEADER_H;

  holeBanks(card).forEach((bank, bankIndex) => {
    if (bankIndex) y += BANK_GAP;
    const cellW = bank.count ? innerW / bank.count : innerW;
    ctx.fillStyle = MUTED;
    ctx.font = "700 18px Archivo, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (let i = 0; i < bank.count; i += 1) {
      ctx.fillText(String(card.holes[bank.start + i]), PAD + NAME_W + cellW * i + cellW / 2, y);
    }
    ctx.textAlign = "right";
    ctx.fillText("TOT", width - PAD - REL_W - 8, y);
    ctx.fillText("PAR", width - PAD, y);
    ctx.textAlign = "center";
    ctx.font = "700 16px Archivo, system-ui, sans-serif";
    for (let i = 0; i < bank.count; i += 1) {
      const par = card.pars[bank.start + i];
      ctx.fillText(typeof par === "number" ? "par " + par : "", PAD + NAME_W + cellW * i + cellW / 2, y + 22);
    }

    y += BANK_HEAD;
    players.forEach((player) => {
      roundRect(ctx, PAD - 8, y, width - PAD * 2 + 16, ROW_H - 8, 14);
      ctx.fillStyle = "rgba(15, 15, 30, 0.35)";
      ctx.fill();

      const mid = y + (ROW_H - 8) / 2;
      ctx.fillStyle = LIGHT;
      ctx.font = "700 24px Archivo, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(ellipsize(ctx, player.label, NAME_W - 12), PAD, mid);

      ctx.textAlign = "center";
      ctx.font = "800 26px Archivo, system-ui, sans-serif";
      for (let i = 0; i < bank.count; i += 1) {
        const strokes = player.scores[bank.start + i];
        ctx.fillStyle = scoreColor(strokes, card.pars[bank.start + i]);
        ctx.fillText(
          typeof strokes === "number" ? String(strokes) : "–",
          PAD + NAME_W + cellW * i + cellW / 2,
          mid,
        );
      }

      ctx.textAlign = "right";
      ctx.fillStyle = LIGHT;
      ctx.font = "800 26px Archivo, system-ui, sans-serif";
      ctx.fillText(player.total == null ? "–" : String(player.total), width - PAD - REL_W - 8, mid);
      ctx.fillStyle = relColor(player.toPar);
      ctx.font = "800 22px Archivo, system-ui, sans-serif";
      ctx.fillText(player.toPar == null ? "–" : relText(player.toPar), width - PAD, mid);
      y += ROW_H;
    });
  });

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = GOLD;
  ctx.font = "700 22px Archivo, system-ui, sans-serif";
  ctx.fillText(card.footer || "gvdgclub.com", PAD, height - 64);
  ctx.fillStyle = MUTED;
  ctx.font = "600 18px Archivo, system-ui, sans-serif";
  ctx.fillText("Keep score with the club", PAD, height - 40);
}

export async function shareCardPng(model) {
  if (typeof document === "undefined") return null;
  const size = shareCardSize(model);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch { /* system fonts still draw */ }
  }
  drawShareCard(ctx, model, size);
  if (typeof canvas.toBlob === "function") {
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
  }
  return null;
}

export function shareCardFile(blob, model) {
  if (!blob) return null;
  const type = blob.type || "image/png";
  return new File([blob], shareCardFileName(model), { type });
}

export function canShareFiles(file) {
  if (!file || typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  try { return navigator.canShare({ files: [file] }); } catch { return false; }
}

export function downloadShareFile(file) {
  if (!file || typeof document === "undefined") return;
  const href = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = href;
  link.download = file.name || "gvdg-scorecard.png";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}
