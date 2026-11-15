import assert from "node:assert/strict";
import test from "node:test";
import { archiveDownloads, MEMBER_ARCHIVE_SCHEMA, parseBackupFile, restoreParts } from "../src/members-app/member-archive-model.js";

const owner = "m_archive";
const manifest = { memberId: owner, schemaVersion: MEMBER_ARCHIVE_SCHEMA, exportedAt: "2026-11-10T20:20:00Z" };
const record = { owner, kind: "disc", sourceId: "disc-1", data: { occurredOn: "2026-11-01", record: { brand: "Téé, \"Star\"" } } };

test("personal archive JSON preserves exact values and deduplicates only identical snapshots", async () => {
  const revised = { ...record, data: { ...record.data, revision: 2 } };
  const [file] = archiveDownloads(manifest, [record, { data: record.data, sourceId: record.sourceId, kind: record.kind, owner }, revised], "json");
  assert.equal(file.name, "gvdg-archive-2026-11-10.json");
  const backup = parseBackupFile(JSON.parse(await file.blob.text()));
  assert.deepEqual(backup.entries, [record, revised]);
  assert.equal(backup.counts.disc, 2);
  assert.throws(() => parseBackupFile({ ...manifest, entries: [record, { ...record, owner: "m_other" }] }), /invalid_backup/);
  assert.deepEqual(parseBackupFile({ ...manifest, entries: [] }).entries, []);
});

test("archive CSV protects spreadsheet formula cells and preserves the structured record", async () => {
  const [file] = archiveDownloads(manifest, [{ ...record, sourceId: "=SUM(1,2)" }], "csv");
  const output = await file.blob.text();
  assert.match(output, /^kind,source_id,round_source,recorded_at,data_json\r\n/);
  assert.match(output, /\r\ndisc,"'=SUM\(1,2\)",,2026-11-01,/);
  assert.match(output, /Téé/);
});

test("restores existing play-history backups and preserves offline clip and clock identity", () => {
  const offline = { source: "offline", offlineSnapshot: { localId: "local-id", startedAt: "2026-11-10T19:00:00Z", finishedAt: "2026-11-10T20:00:00Z" } };
  const imported = { source: "udisc", importedRoundKey: "udisc-key", id: "prior-id" };
  const { entries } = parseBackupFile({ schemaVersion: "gvdg-play-export-2", memberId: owner, rounds: [offline, imported],
    clips: [{ scope: "offline", clientId: "device-key" }, { scope: "event", id: 43 }] });
  assert.deepEqual(entries.map((row) => row.sourceId), ["offline:local-id", "udisc:udisc-key", "offline-clip:device-key", "live-clip:43"]);
  assert.equal(entries[0].data.clock.startedAt, offline.offlineSnapshot.startedAt);
  assert.equal(entries[0].data.clock.finalizedAt, offline.offlineSnapshot.finishedAt);
  assert.equal(entries[1].data.clock.sourcePlayedAt, null);
});

test("restore uses bounded UTF-8 chunks and preserves record order", () => {
  const entries = Array.from({ length: 17 }, (_, index) => ({ ...record, sourceId: index }));
  assert.deepEqual(restoreParts(entries).map((part) => part.length), [16, 1]);
  assert.deepEqual(restoreParts(entries).flat(), entries);
  const multibyte = { ...record, data: "é".repeat(200_000) };
  assert.deepEqual(restoreParts([multibyte, multibyte]).map((part) => part.length), [1, 1]);
  assert.throws(() => restoreParts([{ ...record, data: "é".repeat(400_000) }]), /entry_too_large/);
});
