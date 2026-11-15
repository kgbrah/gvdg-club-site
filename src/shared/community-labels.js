export const COURSE_AMENITIES = [
  ["restrooms", "Restrooms"], ["drinkingWater", "Drinking water"], ["practiceBasket", "Practice basket"],
  ["accessibleParking", "Accessible parking"], ["stepFreeRoute", "Step-free route"],
];
export const COURSE_DIFFICULTIES = [
  ["unknown", "Unknown"], ["beginner", "Beginner"], ["intermediate", "Intermediate"], ["advanced", "Advanced"],
];
export const AMENITY_OPTIONS = [["unknown", "Unknown"], ["yes", "Available"], ["no", "Unavailable"]];
export const REVIEW_REASONS = [["unsafe", "Unsafe information"], ["misleading", "Misleading"], ["abuse", "Abusive content"], ["other", "Other"]];

export function communityDate(timestamp) {
  return typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2}/.test(timestamp) ? timestamp.slice(0, 10) : "";
}
