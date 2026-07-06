import React from "react";

export const CLUB_DIRECTORY_EVENT = "gvdg:club-directory-data-ready";

function normalizeYearData(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([year, count]) => [String(year), Number(count)])
      .filter(([year, count]) => /^\d{4}$/.test(year) && Number.isFinite(count) && count >= 0),
  );
}

function normalizeMember(member) {
  if (!member || typeof member !== "object") return null;
  const firstName = String(member.firstName || "").trim();
  const lastName = String(member.lastName || "").trim();
  const yearJoined = Number(member.yearJoined);
  if (!firstName || !lastName || !Number.isFinite(yearJoined)) return null;
  return {
    firstName,
    lastName,
    yearJoined,
    pdga: member.pdga == null ? null : String(member.pdga).trim(),
    special: member.special == null ? null : String(member.special).trim(),
  };
}

export function memberFullName(member) {
  return `${member.firstName} ${member.lastName}`.trim();
}

export function memberInitials(member) {
  return `${member.firstName[0] || ""}${member.lastName[0] || ""}`.toUpperCase() || "DG";
}

export function clubDirectoryData() {
  const raw = window.GVDG_CLUB_DIRECTORY_DATA;
  const members = Array.isArray(raw?.members) ? raw.members.map(normalizeMember).filter(Boolean) : [];
  const yearData = normalizeYearData(raw?.yearData);
  return members.length ? { members, yearData } : null;
}

export function useClubDirectoryData() {
  const [data, setData] = React.useState(() => clubDirectoryData());

  React.useEffect(() => {
    function update() {
      setData(clubDirectoryData());
    }
    update();
    window.addEventListener(CLUB_DIRECTORY_EVENT, update);
    return () => window.removeEventListener(CLUB_DIRECTORY_EVENT, update);
  }, []);

  return data;
}
