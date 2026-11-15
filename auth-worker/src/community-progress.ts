import type { D1Like } from "./db.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const CLUB_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

const COMPLETED = `
  WITH completed AS (
    SELECT 'club' AS source, coalesce(nullif(e.date, ''), MIN(r.created_at)) AS played_at
      FROM results r JOIN events e ON e.id = r.event_id
      WHERE r.member_id = ? AND e.status = 'final' AND e.type IN ('tournament', 'league_round') AND r.place > 0
      GROUP BY e.id
    UNION ALL
    SELECT 'casual' AS source, coalesce(nullif(c.started_at, ''), c.finalized_at) AS played_at
      FROM casual_results r JOIN casual_rounds c ON c.id = r.casual_round_id
      WHERE r.member_id = ? AND r.place > 0
      GROUP BY c.id
  )
`;

export async function communityRoundTotals(db: D1Like, memberId: string, date = CLUB_DATE.format(Date.now())) {
  const tomorrow = dateLabel(Date.parse(date + "T00:00:00Z") + DAY);
  const { results } = await db.prepare(COMPLETED + `
    SELECT source, CASE WHEN date(played_at) >= ? THEN played_at ELSE '' END AS boundary, count(*) AS total
    FROM completed WHERE date(played_at) <= ? GROUP BY source, boundary`)
    .bind(memberId, memberId, date, tomorrow).all<{ source: string; total: number; boundary: string }>();
  const totals = { club: 0, casual: 0 };
  for (const row of results) {
    if ((row.source === "club" || row.source === "casual") && (!row.boundary || localDay(row.boundary, row.source) <= date)) {
      totals[row.source] += row.total;
    }
  }
  return totals;
}

function localDay(value: string, source: string) {
  if (source === "club" && /^\d{4}-\d\d-\d\d/.test(value)) return value.slice(0, 10);
  if (/^\d{4}-\d\d-\d\d$/.test(value)) return value;
  const iso = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? CLUB_DATE.format(time) : "";
}

function monday(date: string) {
  const time = Date.parse(date + "T00:00:00Z");
  return time - ((new Date(time).getUTCDay() + 6) % 7) * DAY;
}

function dateLabel(time: number) { return new Date(time).toISOString().slice(0, 10); }

export async function communityProgress(db: D1Like, memberId: string, now = Date.now()) {
  const today = CLUB_DATE.format(now);
  const lastWeek = monday(today);
  const firstWeek = lastWeek - 52 * WEEK;
  const [totals, activity] = await Promise.all([
    communityRoundTotals(db, memberId, today),
    db.prepare(COMPLETED + " SELECT source, played_at, count(*) AS total FROM completed WHERE date(played_at) >= ? AND date(played_at) <= ? GROUP BY source, played_at")
      .bind(memberId, memberId, dateLabel(firstWeek - DAY), dateLabel(lastWeek + WEEK)).all<{ source: string; played_at: string; total: number }>(),
  ]);
  const counts = new Map<number, number>();
  for (const row of activity.results) {
    const date = localDay(row.played_at, row.source);
    if (!date || date > today) continue;
    const start = monday(date);
    counts.set(start, (counts.get(start) || 0) + row.total);
  }
  let streak = 0;
  const start = counts.get(lastWeek) ? lastWeek : lastWeek - WEEK;
  for (let week = start; week >= firstWeek && streak < 52 && counts.get(week); week -= WEEK) streak++;
  const total = totals.club + totals.casual;
  const thresholds = [1, 5, 10, 25, 50, 100, 250, 500];
  return {
    totals, streak, streakCapped: streak >= 52,
    weekly: Array.from({ length: 8 }, (_, index) => {
      const week = lastWeek - (7 - index) * WEEK;
      return { startsOn: dateLabel(week), rounds: counts.get(week) || 0 };
    }),
    achieved: thresholds.filter((milestone) => milestone <= total),
    next: thresholds.find((milestone) => milestone > total) ?? null,
  };
}
