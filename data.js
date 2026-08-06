/**
 * Sillage seed data — retailers + empty users.
 * Full fragrance catalog loads from catalog.json (~59k entries from the
 * open Parfumo/TidyTuesday dataset — not Fragrantica scrape).
 */
window.SILLAGE_DATA = {
  fragrances: [],
  retailers: [
    { id: "sephora", name: "Sephora" },
    { id: "ultral", name: "Ulta" },
    { id: "fragnet", name: "FragranceNet" },
    { id: "jomashop", name: "Jomashop" },
    { id: "aura", name: "Aura Fragrance" },
    { id: "brand", name: "Brand boutique" },
  ],

  /** Real users only — empty until accounts exist */
  users: [],
};
