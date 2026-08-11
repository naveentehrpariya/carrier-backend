/**
 * Offline IP -> approximate location lookup for audit logging.
 *
 * WHY OFFLINE: audit logs are written on every mutating request. Calling an
 * external geo API per write would add latency to the request path, break when
 * the third party rate-limits us, and ship our users' IP addresses to a vendor.
 * `geoip-lite` bundles a MaxMind GeoLite snapshot and resolves in-process.
 *
 * WHAT THIS IS NOT: an exact location. IP geolocation resolves to the network's
 * registered area, not the person. Country is ~99% right; city is ~55-70% and is
 * often the mobile carrier's gateway or the VPN exit, hundreds of km away.
 * Every value returned here carries `approx: true` and an `accuracyKm` radius so
 * the UI can never present it as fact. Same rule as approximated stop addresses
 * and FX snapshots: an estimated value must travel with its own uncertainty.
 */

let geoip = null;
try {
  // Optional dependency — the audit log must keep working without it.
  geoip = require('geoip-lite');
} catch (err) {
  console.warn('[geoLocation] geoip-lite not installed; IP location disabled.');
}

/** Private / loopback / link-local ranges never resolve to a public location. */
const PRIVATE_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fe80:/i,
  /^f[cd][0-9a-f]{2}:/i,
];

/**
 * Pull the client IP out of a request.
 * Trusts the FIRST entry of x-forwarded-for (the original client) — later
 * entries are our own proxies.
 */
function extractIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  const raw =
    (typeof forwarded === 'string' ? forwarded.split(',')[0] : null) ||
    req?.headers?.['x-real-ip'] ||
    req?.ip ||
    req?.connection?.remoteAddress ||
    req?.socket?.remoteAddress ||
    '';
  return normalizeIp(String(raw).trim());
}

/** Strip the IPv4-mapped IPv6 prefix (::ffff:1.2.3.4) and any :port suffix. */
function normalizeIp(ip) {
  if (!ip) return '';
  let out = ip.replace(/^::ffff:/i, '');
  // "1.2.3.4:5678" — only for IPv4, a bare IPv6 has many colons.
  if ((out.match(/:/g) || []).length === 1 && out.includes('.')) {
    out = out.split(':')[0];
  }
  return out;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  return PRIVATE_PATTERNS.some((re) => re.test(ip));
}

/**
 * Resolve an IP to an approximate location.
 *
 * @param {string} ip
 * @returns {{
 *   country: string, region: string, city: string, timezone: string,
 *   coordinates: number[]|null, accuracyKm: number|null,
 *   approx: boolean, source: string, label: string
 * }|null}  null when nothing could be resolved
 */
function lookupLocation(ip) {
  const clean = normalizeIp(ip);
  if (!clean) return null;

  if (isPrivateIp(clean)) {
    return {
      country: '',
      region: '',
      city: '',
      timezone: '',
      coordinates: null,
      accuracyKm: null,
      approx: true,
      source: 'private',
      label: 'Local / private network',
    };
  }

  if (!geoip) return null;

  let hit = null;
  try {
    hit = geoip.lookup(clean);
  } catch (err) {
    return null;
  }
  if (!hit) return null;

  const country = hit.country || '';
  const region = hit.region || '';
  const city = hit.city || '';

  return {
    country,
    region,
    city,
    timezone: hit.timezone || '',
    coordinates: Array.isArray(hit.ll) ? hit.ll : null,
    // `area` is MaxMind's accuracy radius in km. A blank city usually comes with
    // a 1000km radius — that is a country-level guess, not a city.
    accuracyKm: typeof hit.area === 'number' ? hit.area : null,
    approx: true,
    source: 'geoip-lite',
    label: formatLocation({ city, region, country }),
  };
}

/** "Ashburn, VA, US" — skips whatever is missing. */
function formatLocation({ city, region, country } = {}) {
  const parts = [city, region, country].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Unknown location';
}

/** Convenience: IP + its approximate location straight off the request. */
function resolveRequestLocation(req) {
  const ip = extractIp(req);
  return { ip, location: lookupLocation(ip) };
}

module.exports = {
  extractIp,
  normalizeIp,
  isPrivateIp,
  lookupLocation,
  formatLocation,
  resolveRequestLocation,
};
