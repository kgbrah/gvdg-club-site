import React from "react";

import { requestJson } from "./api.js";
import { formatRatingDate, formatToPar, plural } from "./format.js";
import { displayMatchStatus } from "../shared/match-status.js";
import { UDiscExportDetails } from "../shared/udisc-export.js";

const h = React.createElement;
const RATING_PAGE_SIZE = 250;
const KINDS = ["competitive", "casual"];

function emptyKind() {
  return { rounds: [], liveRating: null, ratedShown: 0, archivedShown: 0, totalShown: 0, eligibleRated: 0, minimumRated: 8, offset: 0, hasMore: false, loading: false };
}

function initialState() {
  return { owner: null, status: "idle", competitive: emptyKind(), casual: emptyKind() };
}

function ratingValue(value) {
  return value == null ? "-" : String(value);
}

function parseObject(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function matchSummary(round) {
  const match = parseObject(round.match_result);
  if (!match) return null;
  const scoringGroup = parseObject(round.scoring_group);
  const team = scoringGroup?.label ? `${scoringGroup.label} - ` : "";
  return `${team}${displayMatchStatus(match)}`;
}

function roundMeta(round) {
  const parts = [];
  const when = formatRatingDate(round.date);
  const match = matchSummary(round);
  if (when) parts.push(when);
  if (match) parts.push(match);
  else if (round.total != null) parts.push(`${round.total} (${formatToPar(round.to_par)})`);
  if (round.round_code) parts.push(`Round ${round.round_code}`);
  return parts.join(" - ");
}

function mergeKind(previous, group, append) {
  const rounds = Array.isArray(group?.rounds) ? group.rounds : [];
  return {
    rounds: append ? previous.rounds.concat(rounds) : rounds,
    liveRating: group?.live_rating ?? null,
    eligibleRated: group?.eligible_rated_rounds ?? 0,
    minimumRated: group?.minimum_rated_rounds ?? 8,
    ratedShown: (append ? previous.ratedShown : 0) + (group?.rated_rounds || 0),
    archivedShown: (append ? previous.archivedShown : 0) + rounds.filter((round) => round.rating_method === "archived").length,
    totalShown: (append ? previous.totalShown : 0) + rounds.length,
    offset: (append ? previous.offset : 0) + rounds.length,
    hasMore: rounds.length === RATING_PAGE_SIZE,
    loading: false,
  };
}

function useClubRatings(token) {
  const [state, setState] = React.useState(initialState);
  const stateRef = React.useRef(state);
  const active = React.useRef(null);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const load = React.useCallback(async ({ appendKind = null } = {}) => {
    if (!token) {
      setState(initialState());
      return;
    }
    const current = stateRef.current;
    const reset = appendKind == null;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState((prev) => {
      const account = prev.owner === token ? prev : initialState();
      return {
        owner: token,
        status: "loading",
        competitive: { ...account.competitive, loading: reset || appendKind === "competitive" },
        casual: { ...account.casual, loading: reset || appendKind === "casual" },
      };
    });

    const params = new URLSearchParams({
      competitiveLimit: String((reset || appendKind === "competitive") ? RATING_PAGE_SIZE : 0),
      casualLimit: String((reset || appendKind === "casual") ? RATING_PAGE_SIZE : 0),
      competitiveOffset: String(reset ? 0 : current.competitive.offset),
      casualOffset: String(reset ? 0 : current.casual.offset),
    });

    try {
      const data = await requestJson(`/my-ratings?${params.toString()}`, { token, signal: controller.signal });
      if (controller.signal.aborted) return;
      setState((prev) => ({
        owner: token,
        status: "ready",
        competitive: appendKind === "casual" ? { ...prev.competitive, loading: false } : mergeKind(prev.competitive, data.competitive, !reset),
        casual: appendKind === "competitive" ? { ...prev.casual, loading: false } : mergeKind(prev.casual, data.casual, !reset),
      }));
    } catch {
      if (!controller.signal.aborted) {
        setState((prev) => ({ ...prev, status: "error", competitive: { ...prev.competitive, loading: false }, casual: { ...prev.casual, loading: false } }));
      }
    }
  }, [token]);

  React.useEffect(() => {
    void load();
    return () => active.current?.abort();
  }, [load]);

  return { state: state.owner === token ? state : initialState(), loadMore: (kind) => load({ appendKind: kind }) };
}

const UNRATED_REASONS = {
  "not-singles-stroke": "Club ratings apply to singles stroke play.",
  "incomplete-result": "No completed singles score.",
  "not-enough-prior-anchors": "Too few prior ratings to calibrate this field.",
  "no-prior-layout-baseline": "No earlier calibration for this layout.",
  "unverified-layout-revision": "As-played tee or basket positions are missing.",
  "rating-source-changed": "The scorecard or its calibration changed. This round needs a new rating.",
  "missing-rating-evidence": "No rating evidence is available for this round.",
};

function ratingLabel(round) {
  if (round.rating == null) return "Unrated";
  if (round.rating_method === "provisional") return "Provisional";
  if (round.rating_method === "layout") return "Layout estimate";
  if (round.rating_method === "stable") return "Club estimate";
  if (round.rating_source === "estimated") return "Est.";
  return "Archived rating";
}

function ratingEvidence(round) {
  if (round.rating == null) {
    const reason = UNRATED_REASONS[round.unrated_reason];
    return reason && round.anchor_count ? reason + " " + round.anchor_count + " available." : reason;
  }
  const count = round.propagator_count;
  if (round.rating_method === "layout") return count ? "Earlier same-layout field · " + count + " anchors" : "";
  if (count) return count + " prior rating " + plural(count, "anchor", "anchors");
  return "";
}

function RatingRoundRow({ round, kind }) {
  const title = `${round.place != null ? `#${round.place} - ` : ""}${round.label || (kind === "competitive" ? "Competitive round" : "Casual round")}`;
  return h(React.Fragment, null, [
    h("div", { className: "club-rating-row", key: "row" }, [
      h("div", { key: "main" }, [
        h("div", { className: "club-rating-title", key: "title" }, title),
        roundMeta(round) ? h("div", { className: "club-rating-meta", key: "meta" }, roundMeta(round)) : null,
        ratingEvidence(round) ? h("div", { className: "club-rating-meta", key: "evidence" }, ratingEvidence(round)) : null,
      ]),
      h("div", { className: "club-rating-score", key: "score" }, [
        h("div", { className: "club-rating-score-main", key: "rating" }, ratingValue(round.rating)),
        h("div", { className: "club-rating-score-sub", key: "source" }, ratingLabel(round)),
      ]),
    ]),
    h("div", { className: "club-rating-export", key: "export" },
      h(UDiscExportDetails, { courseId: round.udisc_course_id, scorecard: round.scorecard }),
    ),
  ]);
}

function RatingPanel({ kind, title, group, onLoadMore }) {
  const empty = kind === "competitive" ? "No finalized competitive rounds yet." : "No finalized casual rounds yet.";
  return h("section", { className: "club-rating-panel", "aria-labelledby": `${kind}ReactRatingTitle` }, [
    h("div", { className: "club-rating-head", key: "head" }, [
      h("div", { key: "title" }, [
        h("div", { className: "club-rating-label", id: `${kind}ReactRatingTitle`, key: "label" }, title),
        h("div", { className: "club-rating-count", key: "count" }, `${group.ratedShown} rated ${plural(group.ratedShown, "round", "rounds")} / ${group.totalShown} shown`),
      ]),
      h("div", { className: "club-rating-live", key: "live" }, [
        h("div", { className: "club-rating-number", key: "number" }, ratingValue(group.liveRating)),
        h("div", { className: "club-rating-live-label", key: "label" }, "Club estimate"),
        h("div", { className: "club-rating-count", key: "evidence" }, group.liveRating == null
          ? group.eligibleRated + " of " + group.minimumRated + " needed in the past year"
          : group.eligibleRated + " eligible rated rounds in the past year"),
      ]),
    ]),
    group.archivedShown ? h("p", { className: "club-rating-count", key: "archive" },
      group.archivedShown + " archived " + plural(group.archivedShown, "rating is", "ratings are") + " shown below. The overall estimate uses at least " + group.minimumRated + " eligible rounds from the past year.") : null,
    h("div", { className: "club-rating-list", key: "list" }, group.rounds.length
      ? group.rounds.map((round, index) => h(RatingRoundRow, { round, kind, key: `${kind}-${round.id || index}` }))
      : h("div", { className: "club-rating-empty" }, empty)),
    group.hasMore || group.loading
      ? h("div", { className: "club-rating-actions", key: "actions" }, h(
        "button",
        { type: "button", className: "club-rating-load-btn", disabled: group.loading, onClick: onLoadMore },
        group.loading ? "Loading..." : `Load more ${kind} rounds`,
      ))
      : null,
  ]);
}

export function ClubRatings({ token }) {
  const { state, loadMore } = useClubRatings(token);
  if (!token || state.status === "error") return null;

  return h("div", { className: "club-ratings react-club-ratings", "data-react-club-ratings": state.status }, [
    h("h4", { className: "dash-subtitle", key: "title" }, "GVDG Round Ratings"),
    h("div", { className: "club-rating-grid", key: "grid" }, KINDS.map((kind) => h(RatingPanel, {
      kind,
      title: kind === "competitive" ? "Competitive" : "Casual",
      group: state[kind],
      onLoadMore: () => loadMore(kind),
      key: kind,
    }))),
  ]);
}
