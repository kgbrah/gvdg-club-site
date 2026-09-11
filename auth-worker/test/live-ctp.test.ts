import { describe, expect, it } from "vitest";
import {
  agreedNominee,
  cardLiveCtps,
  ctpAwardWinners,
  currentCtpLeader,
  publicLiveCtps,
  recordCtpVote,
  type LiveCtpStore,
} from "../src/live-ctp.js";
import type { PlayerState } from "../src/scoring.js";

function player(over: Partial<PlayerState> & { name: string; cardId?: string | null }): PlayerState {
  return { memberId: over.memberId ?? null, division: over.division ?? null, team: over.team ?? null, cardId: over.cardId ?? "c0", scores: {}, ...over };
}

const card = [
  player({ memberId: "m_a", name: "Ann", cardId: "c0" }),
  player({ memberId: "m_b", name: "Bo", cardId: "c0" }),
  player({ memberId: "m_c", name: "Cy", cardId: "c1" }),
];

const ctp = { id: 9, hole: 7, division: null };

describe("live CTP card claims", () => {
  it("does not make a leader until every player on the card votes for the same nominee", () => {
    let store: LiveCtpStore = {};
    const first = recordCtpVote({ store, players: card, ctp, nomineeIndex: 0, scorerIndex: 0, now: "2026-09-11T10:00:00.000Z" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.leader).toBeNull();
    store = first.store;

    const second = recordCtpVote({ store, players: card, ctp, nomineeIndex: 0, scorerIndex: 1, now: "2026-09-11T10:00:01.000Z" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.leader).toEqual({
      ctpId: 9,
      hole: 7,
      playerIndex: 0,
      memberId: "m_a",
      name: "Ann",
      cardId: "c0",
    });
  });

  it("rejects a nominee on another card", () => {
    const result = recordCtpVote({ store: {}, players: card, ctp, nomineeIndex: 2, scorerIndex: 0, now: "2026-09-11T10:00:00.000Z" });
    expect(result).toEqual({ ok: false, error: "wrong_card", status: 403 });
  });

  it("lets a later unanimous card replace the current leader", () => {
    let store: LiveCtpStore = {};
    store = (recordCtpVote({ store, players: card, ctp, nomineeIndex: 0, scorerIndex: 0, now: "t1" }) as { store: LiveCtpStore }).store;
    store = (recordCtpVote({ store, players: card, ctp, nomineeIndex: 0, scorerIndex: 1, now: "t2" }) as { store: LiveCtpStore }).store;
    expect(currentCtpLeader(store["9"]!, card)?.name).toBe("Ann");

    store = (recordCtpVote({ store, players: card, ctp, nomineeIndex: 2, scorerIndex: 2, now: "t3" }) as { store: LiveCtpStore }).store;
    expect(currentCtpLeader(store["9"]!, card)?.name).toBe("Cy");
    expect(ctpAwardWinners(store, card).map((row) => row.name)).toEqual(["Cy"]);
  });

  it("drops a card's claim when someone changes their vote", () => {
    let store: LiveCtpStore = {};
    store = (recordCtpVote({ store, players: card, ctp, nomineeIndex: 0, scorerIndex: 0, now: "t1" }) as { store: LiveCtpStore }).store;
    store = (recordCtpVote({ store, players: card, ctp, nomineeIndex: 0, scorerIndex: 1, now: "t2" }) as { store: LiveCtpStore }).store;
    store = (recordCtpVote({ store, players: card, ctp, nomineeIndex: 1, scorerIndex: 1, now: "t3" }) as { store: LiveCtpStore }).store;
    expect(currentCtpLeader(store["9"]!, card)).toBeNull();
    expect(agreedNominee(store["9"]!.votes.null ?? store["9"]!.votes.c0, [{ index: 0 }, { index: 1 }])).toBeNull();
  });

  it("exposes missing names on the card until everyone agrees", () => {
    let store: LiveCtpStore = {};
    store = (recordCtpVote({ store, players: card, ctp, nomineeIndex: 0, scorerIndex: 0, now: "t1" }) as { store: LiveCtpStore }).store;
    const mine = cardLiveCtps(store, card, "c0", 0);
    expect(mine[0]?.myVote).toBe(0);
    expect(mine[0]?.agreed).toBe(false);
    expect(mine[0]?.missingNames).toEqual(["Bo"]);
    expect(publicLiveCtps(store, card)[0]?.leaderName).toBeNull();
  });
});
