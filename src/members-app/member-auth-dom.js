export function byId(id) {
  return document.getElementById(id);
}

export function showError(element, message) {
  if (!element) return;
  element.textContent = `Error: ${message}`;
  element.classList.add("show");
}

export function clearError(element) {
  if (!element) return;
  element.textContent = "";
  element.classList.remove("show");
}

export function setBusy(button, busy) {
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent || "";
  button.disabled = busy;
  button.textContent = busy ? "Please wait..." : button.dataset.label;
}

export function setAuthMode(mode, passkeysSupported) {
  window.dispatchEvent(new CustomEvent("gvdg:member-auth-mode", {
    detail: { mode, passkeysSupported },
  }));
}

export function showLoginShell(passkeysSupported) {
  const gate = byId("loginGate");
  const content = byId("membersContent");
  if (gate) gate.style.display = "flex";
  content?.classList.remove("active");
  setAuthMode("login", passkeysSupported);
  clearError(byId("loginError"));
  clearError(byId("pinChangeError"));
  clearError(byId("profileError"));
}

export function showPinChangeShell(passkeysSupported) {
  const gate = byId("loginGate");
  const content = byId("membersContent");
  if (gate) gate.style.display = "flex";
  content?.classList.remove("active");
  setAuthMode("pin", passkeysSupported);
  clearError(byId("pinChangeError"));
  requestAnimationFrame(() => byId("newPinInput")?.focus());
}

export function showMembersShell(name) {
  const gate = byId("loginGate");
  const content = byId("membersContent");
  if (gate) gate.style.display = "none";
  content?.classList.add("active");
  const passkeyStatus = byId("passkeyStatus");
  if (passkeyStatus) passkeyStatus.textContent = "";
  window.dispatchEvent(new CustomEvent("gvdg:member-dashboard-opened", {
    detail: { name: name || null },
  }));
}
