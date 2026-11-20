// A member's profile photo as the app shows it. Older profiles could point at a pdga.com picture; PDGA's content
// stays on pdga.com (PDGA's Terms of Use), so those are not shown and the member's initials stand in.
const PDGA_PHOTO = /^https?:\/\/([a-z0-9-]+\.)*pdga\.com\//i;

export function shownProfilePhoto(value) {
  const photo = typeof value === "string" ? value.trim() : "";
  return photo && !PDGA_PHOTO.test(photo) ? photo : "";
}
