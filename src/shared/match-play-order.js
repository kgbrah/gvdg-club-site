export function matchPlayStartHole(holes, cardmates) {
  const assigned = new Set(cardmates.map((player) => player.startingHole).filter((start) =>
    Number.isInteger(start) && holes.some((hole) => hole.hole === start)));
  return assigned.size === 1 ? [...assigned][0] : null;
}

// Only a fully scored sequence from the card's assigned start proves an early clinch.
export function requiredMatchPlayHoles(holes, start, scoresAt) {
  const index = holes.findIndex((hole) => hole.hole === start);
  const order = index > 0 ? holes.slice(index).concat(holes.slice(0, index)) : holes;
  let lead = 0;
  for (const [played, { hole }] of order.entries()) {
    const [left, right] = scoresAt(hole);
    if (typeof left !== "number" || typeof right !== "number") return holes;
    lead += Math.sign(right - left);
    if (Math.abs(lead) > order.length - played - 1) return order.slice(0, played + 1);
  }
  return holes;
}
