// "Crotts" — the GVDG club assistant. Pure prompt assembly (no AI/DOM/D1 here) so it's unit-testable.
// The Worker route fetches club context (events/courses) from D1 and calls Workers AI with these messages.

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const MAX_HISTORY = 8; // most-recent conversation turns kept (excludes the new user message)
export const MAX_CONTENT = 1500; // per-message character cap
const MAX_CTX_EVENTS = 8;
const MAX_CTX_COURSES = 30;

const PERSONA = [
  "You are Crotts, the friendly assistant for the Greenville Disc Golf Club (GVDG) in Greenville, NC.",
  "You are named after — and speak in the voice of — Max Crotts, a longtime club officer. Max is warm, plain-spoken, and understated, with a dry, punny sense of humor and an adventurer's heart: he's into disc golf, road trips, national parks, camping, good food, books, and trivia. Write in short, easygoing declarative sentences, like you're chatting at the tee pad. Be curious and community-minded — always happy to swap a recommendation. Lean on gentle wordplay over hype, stay humble and encouraging, and never sound corporate or stiff. As an occasional signature you can sign off with Max's little smiley \": ) :\". Keep it welcoming to everyone and steer clear of politics.",
  "Help visitors with club info, disc golf questions, and using the website. If you don't know something, say so and point them to greenvillediscgolf@gmail.com.",
  "Site help: members sign in on the Members page with their PDGA# or UDisc username plus a PIN; the portal shows live PDGA ratings/stats. Donations go through PayPal to @greenvillediscgolf. The Ryder Cup page tracks the club's signature event.",
  "The club's calendar has two distinct kinds, listed separately in the context below: \"Events\" are disc golf tournaments and league rounds; \"Club events\" are fundraisers, meetings, and minutes. Use those terms and keep them separate — don't call a tournament a club event or vice versa.",
  "You know your North Carolina disc golf history (background provided below) and love sharing it, but treat exact dates, winners, and records as background — if you're not certain of a specific, say so rather than guess.",
  "Keep answers short (a few sentences). Never invent events, dates, or results that aren't in the context below.",
].join(" ");

// Background knowledge so Crotts can talk North Carolina disc golf history. General reference only — the
// live club context (events/courses) below always takes priority, and Crotts should hedge on exact
// dates/winners it isn't sure of rather than state them as fact.
const NC_DISC_GOLF = [
  "North Carolina is one of the country's deepest disc golf states — routinely ranked among the top five, with well over 400 courses.",
  "Greenville & Pitt County (GVDG's home in eastern NC) have several regulation 18-hole courses, an active scene with multiple weekly leagues and a local disc shop, and a long run of GVDG-hosted PDGA tournaments — including A-tiers — going back more than 15 years. The North Recreational Complex on the east side of town is one of the area courses.",
  "Charlotte is a historic hub: Hornets Nest hosted the PDGA Pro World Championships in 1997 and again in 2012, plus the DGPT Championship from 2019–2021, and Renaissance Park's Gold layout is one of the toughest championship courses in the region (its intermediate RenSke layout came in around the 2015 Tim Selinske Masters).",
  "Just over the South Carolina line in Rock Hill, the United States Disc Golf Championship (USDGC) has run at the Winthrop Gold course every year since 1999 — a marquee event for Carolinas players, founded by Harold Duvall, Jonathan Poole, and Dave Dunipace.",
  "Western NC's scene grew out of Asheville (the WNCDGA), where the Richmond Hill course took shape in the early 2000s.",
  "Spike Hyzer's North Carolina Disc Golf Championship is the long-running state championship. The NC Disc Golf Hall of Fame honors figures like Brian Schweberger, Sam Nicholson, and Steve Lambert, with early pioneers such as Ted Williams and Eric Marx helping put the sport on the map here.",
].join(" ");

function clip(s: string): string {
  return s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT) : s;
}

type CtxItem = { name: string; date?: string | null; status?: string | null };
const fmtItem = (e: CtxItem) => `- ${e.name}${e.date ? " (" + e.date + ")" : ""}${e.status ? " [" + e.status + "]" : ""}`;

function clubContext(events: CtxItem[], clubEvents: CtxItem[], courses: { name: string; location?: string | null }[]): string {
  const lines: string[] = [];

  const ev = (events ?? []).filter((e) => e && e.name && e.status !== "cancelled").slice(0, MAX_CTX_EVENTS);
  lines.push("Events — disc golf tournaments & league rounds:");
  if (ev.length) ev.forEach((e) => lines.push(fmtItem(e)));
  else lines.push("- (no tournaments or league rounds on the schedule right now)");

  const ce = (clubEvents ?? []).filter((e) => e && e.name && e.status !== "cancelled").slice(0, MAX_CTX_EVENTS);
  lines.push("", "Club events — fundraisers, meetings & minutes:");
  if (ce.length) ce.forEach((e) => lines.push(fmtItem(e)));
  else lines.push("- (no club meetings, minutes, or fundraisers posted right now)");

  const cs = (courses ?? []).filter((c) => c && c.name).slice(0, MAX_CTX_COURSES);
  if (cs.length) {
    lines.push("", "Courses the club plays:");
    cs.forEach((c) => lines.push(`- ${c.name}${c.location ? " — " + c.location : ""}`));
  }
  return lines.join("\n");
}

/** Assemble the Workers AI `messages` array: Crotts system prompt (persona + live club context),
 *  then the capped/sanitized prior turns, then the new user message last. */
export function buildMessages(opts: {
  userMessage: string;
  history?: ChatTurn[];
  events?: { name: string; date?: string | null; status?: string | null }[];
  clubEvents?: { name: string; date?: string | null; status?: string | null }[];
  courses?: { name: string; location?: string | null }[];
}): ChatMessage[] {
  const system = `${PERSONA}\n\n--- North Carolina disc golf background (general knowledge) ---\n${NC_DISC_GOLF}\n\n--- Current club context (live; always takes priority) ---\n${clubContext(opts.events ?? [], opts.clubEvents ?? [], opts.courses ?? [])}`;
  const msgs: ChatMessage[] = [{ role: "system", content: system }];

  const clean = (opts.history ?? [])
    .filter((t): t is ChatTurn => !!t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim() !== "")
    .slice(-MAX_HISTORY)
    .map((t) => ({ role: t.role, content: clip(t.content.trim()) }));
  msgs.push(...clean);

  msgs.push({ role: "user", content: clip(opts.userMessage.trim()) });
  return msgs;
}

// A pluggable text generator (OpenRouter, Workers AI, …). `generate` throws on failure.
export interface ReplyProvider {
  name: string;
  generate(messages: ChatMessage[]): Promise<string>;
}

/** Try each provider in order; return the first non-empty reply (trimmed) with its provider name,
 *  falling through on any throw or empty result. Returns null if every provider fails. */
export async function generateReply(
  providers: ReplyProvider[],
  messages: ChatMessage[],
): Promise<{ reply: string; provider: string } | null> {
  for (const p of providers) {
    try {
      const r = (await p.generate(messages))?.trim();
      if (r) return { reply: r, provider: p.name };
    } catch {
      /* provider unavailable — fall back to the next */
    }
  }
  return null;
}
