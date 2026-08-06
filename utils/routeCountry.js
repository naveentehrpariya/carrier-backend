// Border awareness for Google Directions routes.
//
// Why: Google returns the FASTEST route, with no way to say "stay in my country". A
// Pincher Creek (AB) -> Chalk River (ON) load routes through North Dakota/Minnesota because the
// US shortcut is flatter and quicker — 3,111 km instead of the 3,325 km the truck actually drives
// on the Trans-Canada. That distance feeds driver pay, owner settlement and truck gross, so a
// route the truck never takes silently underpays everyone (~133 mi on that order).
//
// Detection uses two independent signals; either one is enough to flag a crossing:
//   1. Google's own route `warnings` ("this route may cross country borders")
//   2. Geometry: sampled polyline points that sit clearly inside the other country
// Signal 2 keeps a safety margin and deliberately returns UNKNOWN in the Windsor/Detroit and
// Niagara corridors, where Canada dips SOUTH of the US and no coarse test can be trusted.
// Signal 1 covers exactly those cases.

// Canada–US land/water border as latitude at a given longitude, west to east.
// Coarse on purpose — we only need to tell a hundreds-of-kilometres detour from a border city.
const BORDER_BY_LON = [
  [-123.32, 49.0],   // Pacific
  [-95.15, 49.0],    // 49th parallel, ends at Lake of the Woods
  [-94.80, 48.85],
  [-93.50, 48.60],
  [-92.50, 48.45],   // Rainy Lake
  [-91.50, 48.20],
  [-90.00, 48.10],   // Pigeon River / Grand Portage
  [-89.50, 48.00],
  [-88.00, 47.80],   // Lake Superior, mid-lake
  [-87.00, 47.60],
  [-86.00, 47.30],
  [-85.00, 46.80],
  [-84.50, 46.50],   // Sault Ste. Marie
];

// East of Lake Superior the border is not a function of longitude — Ontario hangs SOUTH of
// Michigan (Windsor sits below Detroit), so "lat < borderLat ⇒ US" is meaningless there.
// That region is handled by an explicit Ontario polygon instead (see southernOntarioHint).
const AMBIGUOUS_ZONES = [
  { minLon: -74.5, maxLon: -66.5, minLat: 44.5, maxLat: 47.5 },  // Quebec / Vermont / Maine
];

// Canadian shoreline of the southern-Ontario peninsula + Lake Ontario / St. Lawrence, clockwise.
const ONTARIO_PENINSULA = [
  [-82.42, 42.97],  // Sarnia
  [-83.05, 42.32],  // Windsor
  [-82.52, 41.90],  // Point Pelee
  [-80.05, 42.55],  // Long Point
  [-79.25, 42.87],  // Port Colborne
  [-79.07, 43.25],  // Niagara-on-the-Lake
  [-79.38, 43.65],  // Toronto
  [-76.48, 44.23],  // Kingston
  [-74.73, 45.02],  // Cornwall
  [-75.70, 45.42],  // Ottawa
  [-79.46, 46.31],  // North Bay
  [-80.99, 46.49],  // Sudbury
  [-81.66, 45.25],  // Tobermory
  [-81.71, 43.75],  // Goderich
];

// Great Lakes basin south/east of that shoreline: Michigan, Ohio, Pennsylvania, western New York.
const GREAT_LAKES_US_BOX = { minLon: -85.0, maxLon: -75.0, minLat: 40.0, maxLat: 43.6 };

function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Planar degree distance from a point to the nearest polygon edge — good enough for a margin.
function distanceToPolygonDeg(lat, lon, polygon) {
  let min = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x1, y1] = polygon[j];
    const [x2, y2] = polygon[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((lon - x1) * dx + (lat - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    min = Math.min(min, Math.hypot(lon - px, lat - py));
  }
  return min;
}

// 'CA' | 'US' | 'UNKNOWN' for the Great Lakes region. Points near the shoreline (border cities
// like Windsor/Detroit, Niagara/Buffalo) stay UNKNOWN — Google's own warning decides those.
function southernOntarioHint(lat, lon, marginDeg) {
  const box = GREAT_LAKES_US_BOX;
  const inBox = lon >= box.minLon && lon <= box.maxLon && lat >= box.minLat && lat <= box.maxLat;
  const inside = pointInPolygon(lat, lon, ONTARIO_PENINSULA);
  if (!inside && !inBox) return 'UNKNOWN';
  if (distanceToPolygonDeg(lat, lon, ONTARIO_PENINSULA) < marginDeg) return 'UNKNOWN';
  return inside ? 'CA' : 'US';
}

// Alaska panhandle: border runs along 141°W north of the BC coast.
const ALASKA_LON = -141.0;

function borderLatAt(lon) {
  if (lon < BORDER_BY_LON[0][0] || lon > BORDER_BY_LON[BORDER_BY_LON.length - 1][0]) return null;
  for (let i = 0; i < BORDER_BY_LON.length - 1; i++) {
    const [lon1, lat1] = BORDER_BY_LON[i];
    const [lon2, lat2] = BORDER_BY_LON[i + 1];
    if (lon >= lon1 && lon <= lon2) {
      const t = lon2 === lon1 ? 0 : (lon - lon1) / (lon2 - lon1);
      return lat1 + (lat2 - lat1) * t;
    }
  }
  return null;
}

function inAmbiguousZone(lat, lon) {
  return AMBIGUOUS_ZONES.some(
    (z) => lon >= z.minLon && lon <= z.maxLon && lat >= z.minLat && lat <= z.maxLat
  );
}

// 'US' | 'CA' | 'UNKNOWN'. marginDeg keeps border towns out of the US bucket (~0.25° ≈ 28 km).
function pointCountryHint(lat, lon, marginDeg = 0.25) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'UNKNOWN';
  if (lon < ALASKA_LON) return 'UNKNOWN';                 // Alaska side, out of scope
  if (inAmbiguousZone(lat, lon)) return 'UNKNOWN';
  // Great Lakes region first — the longitude table cannot describe it.
  if (lon > -85.0 && lon < -74.5 && lat < 46.6) {
    return southernOntarioHint(lat, lon, marginDeg);
  }
  const borderLat = borderLatAt(lon);
  if (borderLat == null) return 'UNKNOWN';
  if (lat < borderLat - marginDeg) return 'US';
  if (lat > borderLat + marginDeg) return 'CA';
  return 'UNKNOWN';
}

// Standard Google encoded-polyline decoder → [{lat, lng}].
function decodePolyline(encoded) {
  const points = [];
  if (!encoded || typeof encoded !== 'string') return points;
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

const BORDER_WARNING = /(cross|crossing).{0,40}(border|countr)|(border|countr).{0,40}(cross|crossing)/i;

function warningsMentionBorder(route) {
  const warnings = Array.isArray(route?.warnings) ? route.warnings : [];
  return warnings.some((w) => BORDER_WARNING.test(String(w || '')));
}

// Country of an address string, from the trailing country name Google returns in
// legs[].start_address / end_address (e.g. "… , Chalk River, ON K0J 1J0, Canada").
function countryFromAddress(address) {
  const s = String(address || '').trim().toLowerCase();
  if (!s) return null;
  if (/(^|,\s*)canada$/.test(s)) return 'CA';
  if (/(^|,\s*)(usa|united states)$/.test(s)) return 'US';
  return null;
}

// What countries does this route touch, and does it leave `homeCountry`?
function analyzeRoute(route, homeCountry) {
  const points = decodePolyline(route?.overview_polyline?.points);
  const seen = new Set();
  let foreignPoints = 0;

  points.forEach((p) => {
    const hint = pointCountryHint(p.lat, p.lng);
    if (hint === 'UNKNOWN') return;
    seen.add(hint);
    if (homeCountry && hint !== homeCountry) foreignPoints += 1;
  });

  const warned = warningsMentionBorder(route);
  // One stray point near a coarse border segment shouldn't condemn a route; a real detour
  // produces many. Google's own warning is trusted on its own.
  const crossesBorder = warned || foreignPoints >= 2;

  const countries = Array.from(seen);
  if (homeCountry && !countries.includes(homeCountry)) countries.push(homeCountry);
  if (crossesBorder && homeCountry === 'CA' && !countries.includes('US')) countries.push('US');
  if (crossesBorder && homeCountry === 'US' && !countries.includes('CA')) countries.push('CA');

  return {
    crossesBorder,
    countries: countries.sort(),
    foreignPoints,
    warned,
    distanceMeters: totalDistanceMeters(route),
    durationSeconds: totalDurationSeconds(route),
  };
}

function totalDistanceMeters(route) {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  return legs.reduce((acc, l) => acc + (Number(l?.distance?.value) || 0), 0);
}

function totalDurationSeconds(route) {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  return legs.reduce((acc, l) => acc + (Number(l?.duration?.value) || 0), 0);
}

// Country both ends of the trip are in, or null when they differ / can't be read.
// A genuine cross-border load has nothing to fix — the policy only applies to domestic trips.
function resolveHomeCountry(route) {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  if (!legs.length) return null;
  const origin = countryFromAddress(legs[0]?.start_address);
  const destination = countryFromAddress(legs[legs.length - 1]?.end_address);
  if (!origin || !destination || origin !== destination) return null;
  return origin;
}

// Domestic corridors used to force a route back inside the country when every alternative
// Google offers crosses the border. Applies only when the trip actually spans the corridor.
const CORRIDORS = {
  CA: [
    {
      // Prairies <-> Ontario/Quebec: the Trans-Canada north of Lake Superior.
      name: 'trans-canada-north-of-superior',
      spans: (a, b) => Math.min(a.lng, b.lng) < -96 && Math.max(a.lng, b.lng) > -85,
      waypoints: ['Winnipeg, MB, Canada', 'Thunder Bay, ON, Canada', 'Sault Ste. Marie, ON, Canada'],
    },
  ],
  US: [
    {
      // Michigan <-> New York: I-90 south of the Great Lakes instead of cutting through Ontario.
      name: 'i90-south-of-great-lakes',
      spans: (a, b) => Math.min(a.lng, b.lng) < -83 && Math.max(a.lng, b.lng) > -79 &&
        Math.min(a.lat, b.lat) > 40.5,
      waypoints: ['Toledo, OH, USA', 'Cleveland, OH, USA', 'Erie, PA, USA'],
    },
  ],
};

function pickCorridor(homeCountry, startLatLng, endLatLng) {
  const list = CORRIDORS[homeCountry] || [];
  if (!startLatLng || !endLatLng) return null;
  return list.find((c) => c.spans(startLatLng, endLatLng)) || null;
}

function routeEndpoints(route) {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  if (!legs.length) return {};
  const s = legs[0]?.start_location;
  const e = legs[legs.length - 1]?.end_location;
  return {
    start: s ? { lat: Number(s.lat), lng: Number(s.lng) } : null,
    end: e ? { lat: Number(e.lat), lng: Number(e.lng) } : null,
  };
}

module.exports = {
  decodePolyline,
  pointCountryHint,
  countryFromAddress,
  analyzeRoute,
  resolveHomeCountry,
  routeEndpoints,
  pickCorridor,
  totalDistanceMeters,
  totalDurationSeconds,
};
