import "dotenv/config";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { mkdirSync } from "fs";

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const OUTPUT_DIR = "./output";
const VENUES_FILE = `${OUTPUT_DIR}/venues.json`;

// Catskills region search points — spread across the region to get good coverage
// Each point covers a ~25mi radius
const SEARCH_POINTS = [
  { lat: 42.2, lng: -74.25, label: "Central Catskills (Phoenicia/Mt Tremper)" },
  { lat: 42.05, lng: -74.65, label: "Western Catskills (Andes/Margaretville)" },
  { lat: 41.75, lng: -74.85, label: "Sullivan County (Livingston Manor/Roscoe)" },
  { lat: 42.22, lng: -73.86, label: "Eastern Catskills (Catskill/Hudson)" },
  { lat: 42.1, lng: -74.1, label: "Woodstock/Kingston area" },
];

// Place types likely to host events
const PLACE_TYPES = [
  "bar",
  "night_club",
  "performing_arts_theater",
  "event_venue",
  "cultural_center",
  "community_center",
  "library",
  "art_gallery",
];

const RADIUS_METERS = 40_000; // ~25 miles

async function searchNearby(lat, lng, type) {
  const url = "https://places.googleapis.com/v1/places:searchNearby";
  const body = {
    includedTypes: [type],
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: RADIUS_METERS,
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.websiteUri,places.googleMapsUri,places.types,places.id,places.primaryType",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`  ✗ ${type}: ${res.status} — ${text.slice(0, 200)}`);
    return [];
  }

  const data = await res.json();
  return data.places || [];
}

async function discoverVenues() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const allPlaces = new Map(); // keyed by place ID for dedup

  for (const point of SEARCH_POINTS) {
    console.log(`\nSearching near: ${point.label}`);

    for (const type of PLACE_TYPES) {
      const places = await searchNearby(point.lat, point.lng, type);
      console.log(`  ${type}: ${places.length} results`);

      for (const place of places) {
        if (!allPlaces.has(place.id)) {
          allPlaces.set(place.id, {
            id: place.id,
            name: place.displayName?.text,
            address: place.formattedAddress,
            website: place.websiteUri || null,
            mapsUrl: place.googleMapsUri,
            primaryType: place.primaryType,
            types: place.types,
          });
        }
      }
    }
  }

  const venues = [...allPlaces.values()];
  const withWebsite = venues.filter((v) => v.website);

  console.log(`\n--- Summary ---`);
  console.log(`Total unique places: ${venues.length}`);
  console.log(`With website: ${withWebsite.length}`);

  writeFileSync(VENUES_FILE, JSON.stringify(venues, null, 2));
  console.log(`Saved to ${VENUES_FILE}`);
}

discoverVenues().catch(console.error);
