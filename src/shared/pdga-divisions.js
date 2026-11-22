// Shared PDGA Competition Manual 2.01 / 2.05 / tier labels (pure ES module used by both public & admin bundles).

export const STANDARD_DIVISION_LIMITS = {
  MA2: 934,
  MA3: 899,
  MA4: 849,
  FA2: 824,
  FA3: 774,
  FA4: 724,
};

export function isAmateurDivision(division) {
  const code = String(division || "").trim().toUpperCase();
  return /^[MF]A\d+$/.test(code) || /^[MF]J\d{1,2}$/.test(code);
}

export function formatPdgaTier(tier) {
  const code = String(tier || "").trim().toUpperCase();
  if (!code) return "";
  if (code === "L") return "PDGA League";
  if (code === "M") return "PDGA Major";
  if (code === "ES") return "Elite Series";
  if (code === "NT") return "National Tour";
  return `${code}-tier`;
}
