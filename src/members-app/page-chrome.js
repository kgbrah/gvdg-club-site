import { localStorageGet } from "./api.js";

const DARK_ICON = "☀️";
const LIGHT_ICON = "🌙";

export function installMemberPageChrome() {
  const menuToggle = document.querySelector(".menu-toggle");
  const navLinks = document.querySelector(".nav-links");
  menuToggle?.addEventListener("click", () => {
    navLinks?.classList.toggle("active");
  });

  const themeToggle = document.querySelector(".theme-toggle");
  const themeIcon = document.querySelector(".theme-icon");
  if (!themeToggle || !themeIcon) return;

  if (localStorageGet("theme") === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    themeIcon.textContent = DARK_ICON;
  }

  themeToggle.addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    document.documentElement.setAttribute("data-theme", isDark ? "light" : "dark");
    themeIcon.textContent = isDark ? LIGHT_ICON : DARK_ICON;
    localStorage.setItem("theme", isDark ? "light" : "dark");
  });
}
