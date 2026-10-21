// The bot's use cases. Each has its own prompt, knowledge base, voice and
// tools; the active one (a setting) applies to the next call. Kept apart from
// config.js so db.js can name a call's profile without importing config.js
// (which imports db.js).
export const PROFILES = [
  { id: "golden_visa", name: "Golden Visa FAQ" },
  { id: "taj_dubai", name: "Taj Dubai reservations" },
];

export const PROFILE_IDS = PROFILES.map((p) => p.id);

export function profileName(id) {
  return PROFILES.find((p) => p.id === id)?.name ?? id;
}
