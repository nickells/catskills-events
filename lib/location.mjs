// Drops events whose venue/address is clearly outside New York, e.g. AllEvents
// pages that mix in a same-named town in another state or in Canada.

const NON_NY_REGIONS = [
  // US states (and DC) other than NY
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN",
  "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
  "VA", "WA", "WV", "WI", "WY",
  // Canadian provinces and territories
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
];

// ", PA" / ", ON N4S 2R1" / ", VT 05401" — a region code in address position,
// followed only by an optional postal code before a comma or end of string.
const REGION_CODE_RE = new RegExp(
  `,\\s*(?:${NON_NY_REGIONS.join("|")})(?:\\s+[A-Z0-9][A-Z0-9 -]{3,9})?\\s*(?:,|$)`,
);
const CANADA_RE = /\b(?:Canada|Ontario|Quebec|Québec)\b/i;
const CANADIAN_POSTAL_RE = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/;

export function isOutsideNewYork(event) {
  return [event.venue, event.address].some(
    (field) =>
      typeof field === "string" &&
      (REGION_CODE_RE.test(field) || CANADA_RE.test(field) || CANADIAN_POSTAL_RE.test(field)),
  );
}

export function filterOutsideNewYork(events) {
  const kept = [];
  const dropped = [];
  for (const event of events) (isOutsideNewYork(event) ? dropped : kept).push(event);
  return { kept, dropped };
}
