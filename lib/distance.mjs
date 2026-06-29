// Home base: Halcottsville, NY (12438)
const HOME_LAT = 42.2079;
const HOME_LNG = -74.5998;

// Common Catskills/HV town coordinates — avoids geocoding API calls
const TOWN_COORDS = {
  "halcottsville": [42.2079, -74.5998],
  "margaretville": [42.1487, -74.6512],
  "andes": [42.1901, -74.7871],
  "delhi": [42.2782, -74.9160],
  "roxbury": [42.2946, -74.5632],
  "fleischmanns": [42.1718, -74.5321],
  "phoenicia": [42.0839, -74.3098],
  "mount tremper": [42.0433, -74.2580],
  "mt tremper": [42.0433, -74.2580],
  "mt. tremper": [42.0433, -74.2580],
  "woodstock": [42.0409, -74.1182],
  "saugerties": [42.0775, -73.9530],
  "kingston": [41.9270, -73.9974],
  "rhinebeck": [41.9265, -73.9124],
  "hudson": [42.2529, -73.7907],
  "catskill": [42.2168, -73.8632],
  "tannersville": [42.1943, -74.1361],
  "hunter": [42.1843, -74.2182],
  "windham": [42.3043, -74.2599],
  "prattsville": [42.3193, -74.4388],
  "stamford": [42.4068, -74.6161],
  "hobart": [42.3737, -74.6667],
  "bovina": [42.2623, -74.7707],
  "east meredith": [42.3557, -74.8614],
  "walton": [42.1693, -75.1293],
  "livingston manor": [41.9010, -74.8279],
  "roscoe": [41.9350, -74.9109],
  "narrowsburg": [41.6030, -74.9884],
  "ellenville": [41.7170, -74.3960],
  "kerhonkson": [41.7743, -74.2985],
  "high falls": [41.8296, -74.1258],
  "accord": [41.7961, -74.2358],
  "new paltz": [41.7465, -74.0868],
  "beacon": [41.5048, -73.9697],
  "poughkeepsie": [41.7004, -73.9209],
  "hyde park": [41.7843, -73.9338],
  "red hook": [42.0029, -73.8778],
  "tivoli": [42.0571, -73.9055],
  "ghent": [42.3182, -73.6521],
  "chatham": [42.3643, -73.5949],
  "hillsdale": [42.1929, -73.5321],
  "copake": [42.1143, -73.5521],
  "durham": [42.3993, -74.1727],
  "east durham": [42.3946, -74.1138],
  "round top": [42.2843, -74.0727],
  "maplecrest": [42.2693, -74.1527],
  "big indian": [42.1143, -74.4527],
  "olivebridge": [41.8884, -74.2482],
  "hurleyville": [41.7293, -74.7338],
  "liberty": [41.8010, -74.7464],
  "monticello": [41.6543, -74.6893],
  "cooperstown": [42.6993, -74.9244],
  "oneonta": [42.4526, -75.0638],
  "great barrington": [42.1943, -73.3621],
  "athens": [42.2618, -73.8088],
  "coxsackie": [42.3518, -73.8032],
  "greenville": [42.4068, -74.0088],
  "cairo": [42.2993, -74.0127],
  "leeds": [42.2568, -73.9488],
  "annandale-on-hudson": [42.0229, -73.9055],
  "garrison": [41.3843, -73.9474],
  "cold spring": [41.4204, -73.9549],
  "peekskill": [41.2893, -73.9204],
  "newburgh": [41.5034, -74.0104],
  "middletown": [41.4459, -74.4227],
  "warwick": [41.2565, -74.3588],
  "cornwall": [41.4398, -74.0138],
  "new windsor": [41.4737, -74.0238],
  "wappingers falls": [41.5965, -73.9111],
  "milan": [41.9543, -73.8127],
  "stanfordville": [41.8693, -73.6921],
  "smallwood": [41.6243, -74.8638],
  "eldred": [41.5193, -74.8838],
  "bethel": [41.6693, -74.8327],
  "rensselaerville": [42.5068, -74.1527],
  "dobbs ferry": [41.0054, -73.8721],
  "yonkers": [40.9312, -73.8987],
  "white plains": [41.0340, -73.7629],
  "albany": [42.6526, -73.7562],
  "nyack": [41.0907, -73.9174],
};

export function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 3959; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function bearing(lat1, lng1, lat2, lng2) {
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return deg;
}

const ARROWS = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];

function bearingToArrow(deg) {
  const idx = Math.round(deg / 45) % 8;
  return ARROWS[idx];
}

export function getDistanceInfo(town) {
  if (!town) return null;
  const key = town.toLowerCase().trim();
  const coords = TOWN_COORDS[key];
  if (!coords) return null;
  const miles = Math.round(haversineDistance(HOME_LAT, HOME_LNG, coords[0], coords[1]));
  const deg = bearing(HOME_LAT, HOME_LNG, coords[0], coords[1]);
  const arrow = bearingToArrow(deg);
  return { miles, arrow };
}

export { HOME_LAT, HOME_LNG };
