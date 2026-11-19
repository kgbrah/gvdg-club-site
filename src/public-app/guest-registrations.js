// A guest's registrations on this device: event id -> { guestToken, name, ... } (the token manages the sign-up).
const GUEST_REG_KEY = "gvdg_guest_regs";

export function guestRegs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GUEST_REG_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function setGuestReg(eventId, value) {
  const all = guestRegs();
  if (value) all[eventId] = value;
  else delete all[eventId];
  try {
    localStorage.setItem(GUEST_REG_KEY, JSON.stringify(all));
  } catch {
  }
}
