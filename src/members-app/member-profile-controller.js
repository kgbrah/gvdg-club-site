import { NAME_KEY, TOKEN_KEY, storageGet } from "./api.js";
import { byId, clearError, setAuthMode, setBusy, showError } from "./member-auth-dom.js";
import { applyProfile, memberAuthProfile } from "./member-auth-state.js";
import { passkeysSupported } from "./member-passkeys.js";

let pendingPhoto = null;
const PROFILE_PREVIEW_EVENT = "gvdg:member-profile-preview";

function setProfilePreview(src) {
  window.dispatchEvent(new CustomEvent(PROFILE_PREVIEW_EVENT, {
    detail: { src: src || "" },
  }));
}

function resizeImageFile(file, maxPx) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(null);
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

export function createProfileController({ api, showLogin, showMembersContent }) {
  function showProfileSetup() {
    const profile = memberAuthProfile();
    setAuthMode("profile", passkeysSupported());
    clearError(byId("profileError"));

    const pdgaInput = byId("profilePdgaInput");
    const udiscInput = byId("profileUdiscInput");
    if (pdgaInput) pdgaInput.value = profile.pdgaNo || "";
    if (udiscInput) udiscInput.value = profile.udisc || "";
    pendingPhoto = null;
    setProfilePreview(profile.photo || "");
  }

  async function onPhotoChosen(event) {
    const file = event.target?.files?.[0] || event.detail?.files?.[0];
    if (!file) return;
    const dataUrl = await resizeImageFile(file, 256);
    if (!dataUrl || dataUrl.length > 190_000) {
      showError(byId("profileError"), "That image is too large - please pick a smaller one.");
      return;
    }
    clearError(byId("profileError"));
    pendingPhoto = dataUrl;
    setProfilePreview(dataUrl);
  }

  async function saveProfile() {
    const errorElement = byId("profileError");
    clearError(errorElement);
    const token = storageGet(TOKEN_KEY);
    if (!token) {
      showLogin();
      return;
    }

    const pdga = byId("profilePdgaInput")?.value.trim() || "";
    const udisc = byId("profileUdiscInput")?.value.trim() || "";
    if (pdga && !/^\d+$/.test(pdga)) {
      showError(errorElement, "PDGA # must be digits only.");
      return;
    }

    const body = { pdgaNo: pdga, udisc };
    if (pendingPhoto) body.photo = pendingPhoto;
    const button = byId("profileSaveBtn");
    setBusy(button, true);
    try {
      const response = await api("/profile", { method: "POST", token, body });
      if (response.status === 200) {
        applyProfile(await response.json());
        pendingPhoto = null;
        showMembersContent(storageGet(NAME_KEY));
      } else if (response.status === 409) {
        const data = await response.json().catch(() => ({}));
        showError(errorElement, `${data.field === "udisc" ? "That UDisc username" : "That PDGA #"} is already linked to another member.`);
      } else {
        showError(errorElement, "Could not save your profile. Please check the values and try again.");
      }
    } catch {
      showError(errorElement, "Network error. Please try again.");
    } finally {
      setBusy(button, false);
    }
  }

  return { onPhotoChosen, saveProfile, showProfileSetup };
}
