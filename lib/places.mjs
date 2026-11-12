// Place names as the pipeline compares them. Towns arrive as "Catskill, NY", "SAUGERTIES" or
// "Hudson New York"; venues as "The Avalon Lounge" or "Avalon Lounge".

// Needs a comma or space before it: without one, "Albany" lost its "ny" and became "Alba".
const STATE_SUFFIX = /(?:,\s*|\s+)(n\.?y\.?|new york|usa)$/i;

// "Catskill, NY" → "Catskill"
export const stripState = (place) => (place || "").trim().replace(STATE_SUFFIX, "").trim();

// The lookup key into town-coords: "Catskill, NY" → "catskill"
export const townKey = (town) => stripState(town).toLowerCase();

// Letters and digits only, for loose equality: "Tubby's" → "tubbys"
export const squash = (text) => (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// A town or venue squashed, without its state or a leading "the".
export const squashPlace = (place) => squash(stripState(place).replace(/^the\s+/i, ""));

// "236 Wall Street, Kingston" — a street address standing in for a venue's name.
export const isAddress = (venue) => /^\d+\s/.test(venue || "");
