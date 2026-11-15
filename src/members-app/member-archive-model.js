export const MEMBER_ARCHIVE_SCHEMA = "gvdg-personal-archive-1";
export const MEMBER_ARCHIVE_KINDS = ["round", "disc", "throw", "putting", "clip"];
export const MAX_BACKUP_FILE_BYTES = 32 * 1024 * 1024;
const MAX_VOLUME_BYTES = MAX_BACKUP_FILE_BYTES - 32_768;
const MAX_RESTORE_PART = 730_000;
const MAX_RESTORE_RECORDS = 16;
const bytes = (value) => new TextEncoder().encode(value).byteLength;

export function summarizeArchive(entries) {
  const totals = Object.fromEntries(MEMBER_ARCHIVE_KINDS.map((kind) => [kind, 0]));
  for (const entry of entries) {
    if (!MEMBER_ARCHIVE_KINDS.includes(entry?.kind)) throw new Error("invalid_backup");
    totals[entry.kind]++;
  }
  return totals;
}

function legacyEntries(input) {
  const member = input.memberId;
  if (!Array.isArray(input.rounds) || !Array.isArray(input.clips)) throw new Error("invalid_backup");
  return [
    ...input.rounds.map((round) => {
      const sourceId = round?.source === "offline" ? "offline:" + round.offlineSnapshot?.localId
        : round?.source === "udisc" && round.importedRoundKey ? "udisc:" + round.importedRoundKey : round?.id;
      return { owner: member, kind: "round", sourceId, data: { round, clock: {
        startedAt: round?.offlineSnapshot?.startedAt ?? null,
        finalizedAt: round?.offlineSnapshot?.finishedAt ?? null,
        resultRecordedAt: round?.importedAt ?? null,
        sourcePlayedAt: null,
      } } };
    }),
    ...input.clips.map((data) => ({
      owner: member, kind: "clip",
      sourceId: data?.scope === "offline" ? "offline-clip:" + data.clientId : "live-clip:" + data?.id,
      data,
    })),
  ];
}

export function parseBackupFile(input) {
  if (!input || typeof input.memberId !== "string" || !input.memberId.trim()) throw new Error("invalid_backup");
  const entries = input.schemaVersion === MEMBER_ARCHIVE_SCHEMA ? input.entries
    : input.schemaVersion === "gvdg-play-export-2" ? legacyEntries(input) : null;
  if (!Array.isArray(entries) || !entries.every((entry) => entry?.owner === input.memberId)) throw new Error("invalid_backup");
  return { memberId: input.memberId, entries, counts: summarizeArchive(entries) };
}

export function restoreParts(entries) {
  const parts = [];
  let part = [];
  let size = 0;
  for (const entry of entries) {
    const length = bytes(JSON.stringify(entry)) + 1;
    if (length > MAX_RESTORE_PART) throw new Error("entry_too_large");
    if (part.length >= MAX_RESTORE_RECORDS || size + length > MAX_RESTORE_PART) {
      parts.push(part);
      part = [];
      size = 0;
    }
    part.push(entry);
    size += length;
  }
  if (part.length) parts.push(part);
  return parts;
}

function csvCell(value) {
  const text = String(value ?? "");
  const safe = /^[\s\uFEFF]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r\n]/u.test(text) ? "'" + text : text;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function archiveDownloads(manifest, entries, format) {
  const groups = [[]];
  const seen = new Set();
  let size = 0;
  for (const entry of entries) {
    const json = canonicalJson(entry);
    if (seen.has(json)) continue;
    seen.add(json);
    const row = format === "csv"
      ? [entry.kind, entry.sourceId, entry.data.round?.source, entry.data.round?.playedAt || entry.data.occurredOn || entry.data.createdAt,
        json].map(csvCell).join(",") + "\r\n"
      : json;
    const length = bytes(row) + 1;
    if (groups.at(-1).length && size + length > MAX_VOLUME_BYTES) { groups.push([]); size = 0; }
    groups.at(-1).push(row);
    size += length;
  }
  const day = manifest.exportedAt.slice(0, 10);
  return groups.map((rows, index) => {
    const ending = groups.length > 1 ? "-part-" + (index + 1) + "-of-" + groups.length : "";
    const info = { ...manifest, volume: index + 1, volumes: groups.length };
    const parts = format === "csv"
      ? ["kind,source_id,round_source,recorded_at,data_json\r\n", ["manifest", null, null, day, JSON.stringify(info)].map(csvCell).join(","), "\r\n", ...rows]
      : [JSON.stringify(info).slice(0, -1), ',"entries":[', rows.join(","), "]}"];
    return { name: "gvdg-archive-" + day + ending + "." + format, blob: new Blob(parts, {
      type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8",
    }) };
  });
}
