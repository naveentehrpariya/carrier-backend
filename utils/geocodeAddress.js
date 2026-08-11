const axios = require('axios');

// Why this file exists
// --------------------
// Google Places autocomplete only suggests places Google has indexed. A dispatcher who types a real
// facility ("2355 SUMMIT RD, DOF NEW LOCATION, WINNIPEG, MB R2Y 2M1") never sees that exact string in
// the dropdown — the only suggestion is the postal code — so they either accept a suggestion that is
// not the stop they meant, or keep their own text and get NOT_FOUND from Directions, which blocks the
// order save. Neither is acceptable: the typed text is usually correct, it is just not a Google place.
//
// So the typed text stays on the order (it is what the driver reads), and routing falls back to the
// most specific part of it Google CAN place: street + city + postal, then city + postal, then the
// postal code alone. The stop is then routed by coordinates, and the caller is told the route used an
// approximation so the UI can flag it and the dispatcher can override the miles by hand.

const CA_POSTAL = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i;
const US_ZIP = /\b\d{5}(?:-\d{4})?\b/;

/**
 * Progressively less specific forms of one typed address, most specific first.
 * The typed string itself is always first — when Google can place it, nothing here is used.
 */
function addressVariants(address) {
  const raw = String(address || '').trim();
  if (!raw) return [];

  const out = [raw];
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);

  // A facility name usually sits between the street and the city ("2355 SUMMIT RD, DOF NEW LOCATION,
  // WINNIPEG, MB R2Y 2M1"). Keeping the street and dropping the middle is the closest real match, so
  // it is tried before anything that throws the street away.
  if (parts.length >= 3) {
    out.push([parts[0], ...parts.slice(-2)].join(', '));
    out.push([parts[0], parts[parts.length - 1]].join(', '));
  }

  // Then drop leading segments one at a time — handles a leading business name.
  for (let i = 1; i < parts.length - 1; i += 1) {
    out.push(parts.slice(i).join(', '));
  }

  // Last resort: the postal code, which places the stop in the right town even when every word
  // around it is a name only the client uses.
  const postal = raw.match(CA_POSTAL) || raw.match(US_ZIP);
  if (postal) {
    const tail = parts.length > 1 ? parts.slice(-2).join(', ') : '';
    out.push(tail && !tail.includes(postal[0]) ? `${postal[0]}, ${tail}` : postal[0]);
  }

  return [...new Set(out.map((v) => v.trim()).filter(Boolean))];
}

async function geocodeOnce(query, apiKey) {
  const resp = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
    params: { address: query, key: apiKey },
    timeout: 10000,
  });
  const data = resp?.data;
  if (data?.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) return null;
  const hit = data.results[0];
  const loc = hit?.geometry?.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
  return {
    formatted: hit.formatted_address || query,
    lat: loc.lat,
    lng: loc.lng,
    partial: !!hit.partial_match,
  };
}

/**
 * Resolve one typed stop to something Directions can route.
 * Returns { ok, query, typed, matchedInput, formatted, approximate, reason } — `query` is a
 * "lat,lng" string, which Directions never rejects.
 */
async function resolveStopAddress(address, apiKey) {
  const typed = String(address || '').trim();
  const variants = addressVariants(typed);
  if (!variants.length) return { ok: false, typed, reason: 'empty' };

  for (let i = 0; i < variants.length; i += 1) {
    let hit = null;
    try {
      hit = await geocodeOnce(variants[i], apiKey);
    } catch {
      // A network blip is not proof the address is bad — try the next, looser variant.
      continue;
    }
    if (!hit) continue;
    return {
      ok: true,
      typed,
      matchedInput: variants[i],
      formatted: hit.formatted,
      lat: hit.lat,
      lng: hit.lng,
      query: `${hit.lat},${hit.lng}`,
      // i === 0 means the typed text itself geocoded; anything else is a reduced form, and a
      // partial match on the typed text is still Google guessing.
      approximate: i > 0 || hit.partial,
    };
  }

  return { ok: false, typed, reason: 'not_found' };
}

/**
 * Resolve every stop on a route. One geocode call per stop in the common case.
 * Returns { ok, queries, stops, approximated, unresolved }.
 *   ok           — every stop resolved, so the route can be retried by coordinates
 *   queries      — "lat,lng" per stop, in the original order
 *   approximated — stops whose typed text Google could not place exactly
 *   unresolved   — typed strings nothing could be made of
 */
async function resolveStops(locations, apiKey) {
  const list = Array.isArray(locations) ? locations : [];
  const stops = await Promise.all(list.map((a) => resolveStopAddress(a, apiKey)));
  const unresolved = stops.filter((s) => !s.ok).map((s) => s.typed);
  return {
    ok: unresolved.length === 0 && stops.length > 0,
    queries: stops.map((s) => (s.ok ? s.query : null)),
    stops,
    approximated: stops
      .filter((s) => s.ok && s.approximate)
      .map((s) => ({ typed: s.typed, used: s.formatted, matchedInput: s.matchedInput })),
    unresolved,
  };
}

module.exports = { addressVariants, resolveStopAddress, resolveStops };
