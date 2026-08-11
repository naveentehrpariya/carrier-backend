// Single entry point for "how far is this trip" — used by order distance (/getdistance) and by
// empty-move miles. Applies the company's routing policy so the stored distance matches the route
// the truck actually drives (see utils/routeCountry.js for why Google's default is not enough).
const axios = require('axios');
const Company = require('../db/Company');
const {
  analyzeRoute,
  resolveHomeCountry,
  routeEndpoints,
  pickCorridor,
  totalDistanceMeters,
  totalDurationSeconds,
} = require('./routeCountry');
const { resolveStops } = require('./geocodeAddress');

const DEFAULT_POLICY = 'domestic_only';
const VALID_POLICIES = ['domestic_only', 'fastest'];

function normalizePolicy(value) {
  const v = String(value || '').trim().toLowerCase();
  return VALID_POLICIES.includes(v) ? v : DEFAULT_POLICY;
}

function getGoogleApiKey() {
  return (
    process.env.GOOGLE_MAP_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_KEY ||
    ''
  );
}

// Company-level routing policy. Falls back to the safe default when there is no company row.
async function getRoutePolicy(tenantId) {
  if (!tenantId) return DEFAULT_POLICY;
  try {
    const company = await Company.findOne({ tenantId }).select('route_country_policy').lean();
    return normalizePolicy(company?.route_country_policy);
  } catch {
    return DEFAULT_POLICY;
  }
}

function buildDirectionsUrl({ origin, destination, waypoints, apiKey, alternatives, optimize }) {
  const parts = [
    `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}`,
    `&destination=${encodeURIComponent(destination)}`,
  ];
  if (Array.isArray(waypoints) && waypoints.length) {
    const prefix = optimize ? 'optimize:true|' : '';
    parts.push(`&waypoints=${prefix}${waypoints.map(encodeURIComponent).join('|')}`);
  }
  // Alternatives are what make a domestic route selectable at all — Google only ever puts the
  // fastest one first, and that is the one that dives across the border.
  if (alternatives) parts.push('&alternatives=true');
  parts.push(`&key=${encodeURIComponent(apiKey)}`);
  return parts.join('');
}

async function callDirections(params) {
  const resp = await axios.get(buildDirectionsUrl(params));
  const data = resp?.data;
  if (data?.status !== 'OK' || !Array.isArray(data?.routes) || data.routes.length === 0) {
    return { routes: [], error: data?.error_message || data?.status || 'No route found' };
  }
  return { routes: data.routes, error: null };
}

/**
 * Resolve a route honouring the tenant's routing policy.
 *
 * Returns { ok, meters, km, miles, durationSeconds, crossesBorder, countries, homeCountry,
 *           policy, source, corridorUsed, error }
 *
 * `source`:
 *   'auto_fastest'  — policy off, or trip is genuinely cross-border: Google's best route
 *   'auto_domestic' — an alternative that stays inside the country was chosen
 *   'auto_corridor' — every alternative crossed, so domestic corridor waypoints were forced
 */
async function routeOnce({ origin, destination, waypoints = [], apiKey, activePolicy, optimizeWaypoints = false }) {
  const first = await callDirections({
    origin,
    destination,
    waypoints,
    apiKey,
    alternatives: activePolicy === 'domestic_only',
    optimize: optimizeWaypoints,
  });
  if (first.error) return { ok: false, error: first.error, policy: activePolicy };

  const homeCountry = resolveHomeCountry(first.routes[0]);
  const analyzed = first.routes.map((route) => ({ route, info: analyzeRoute(route, homeCountry) }));
  const best = analyzed[0];

  const finish = (chosen, source, corridorUsed = null) => ({
    ok: true,
    meters: chosen.info.distanceMeters,
    km: Number((chosen.info.distanceMeters / 1000).toFixed(2)),
    miles: Number((chosen.info.distanceMeters / 1609.344).toFixed(2)),
    durationSeconds: chosen.info.durationSeconds,
    crossesBorder: chosen.info.crossesBorder,
    countries: chosen.info.countries,
    homeCountry,
    policy: activePolicy,
    source,
    corridorUsed,
    error: null,
  });

  // Policy off, or a genuine cross-border load (origin and destination in different countries):
  // nothing to correct, keep Google's answer.
  if (activePolicy !== 'domestic_only' || !homeCountry) {
    return finish(best, 'auto_fastest');
  }

  // Prefer the shortest route that stays inside the country.
  const domestic = analyzed
    .filter((a) => !a.info.crossesBorder)
    .sort((a, b) => a.info.distanceMeters - b.info.distanceMeters)[0];
  if (domestic) {
    return finish(domestic, domestic === best ? 'auto_fastest' : 'auto_domestic');
  }

  // Every alternative crosses. Force the domestic corridor for this lane, if one applies.
  const { start, end } = routeEndpoints(best.route);
  const corridor = pickCorridor(homeCountry, start, end);
  if (corridor) {
    const retry = await callDirections({
      origin,
      destination,
      // Corridor waypoints must keep their order — optimize:true would let Google reshuffle
      // them back into a border-crossing sequence.
      waypoints: [...waypoints, ...corridor.waypoints],
      apiKey,
      alternatives: false,
      optimize: false,
    });
    if (!retry.error && retry.routes.length) {
      const forced = { route: retry.routes[0], info: analyzeRoute(retry.routes[0], homeCountry) };
      return finish(forced, 'auto_corridor', corridor.name);
    }
  }

  // No domestic option at all — return the fastest, flagged, so the UI can warn the dispatcher.
  return finish(best, 'auto_fastest');
}

// ZERO_RESULTS means every stop WAS found — there is simply no driving route between them. That is
// almost always one stop that geocoded into the wrong place (a facility name matching a town on
// another continent), and the whole-route error names nothing. Walk the stops in pairs to find the
// break, and hand back where each stop actually landed so the dispatcher can see the wrong one.
async function diagnoseUnroutable(stops, apiKey) {
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (!a?.ok || !b?.ok) continue;
    const leg = await callDirections({ origin: a.query, destination: b.query, waypoints: [], apiKey });
    if (leg.error) {
      return {
        from: { typed: a.typed, resolvedTo: a.formatted },
        to: { typed: b.typed, resolvedTo: b.formatted },
        status: leg.error,
      };
    }
  }
  return null;
}

async function resolveRouteDistance({ origin, destination, waypoints = [], tenantId, policy, optimizeWaypoints = false }) {
  const apiKey = getGoogleApiKey();
  if (!apiKey) return { ok: false, error: 'Google API key not configured' };
  if (!origin || !destination) return { ok: false, error: 'Origin and destination are required' };

  const activePolicy = policy ? normalizePolicy(policy) : await getRoutePolicy(tenantId);
  const args = { origin, destination, waypoints, apiKey, activePolicy, optimizeWaypoints };

  const direct = await routeOnce(args);
  if (direct.ok) return { ...direct, approximatedStops: [] };

  // Directions failed on the typed text. That is usually one stop Google has no place for — a client
  // facility name, a yard, a new location — not a bad lane. Geocode each stop down to something
  // placeable and route by coordinates instead of blocking the order. The typed address is untouched;
  // the caller gets `approximatedStops` so the UI can flag it and the dispatcher can type the miles.
  const stops = [origin, ...waypoints, destination];
  const resolution = await resolveStops(stops, apiKey);
  if (!resolution.ok) {
    return { ok: false, error: direct.error, policy: activePolicy, unresolved: resolution.unresolved };
  }

  const queries = resolution.queries;
  const retry = await routeOnce({
    ...args,
    origin: queries[0],
    destination: queries[queries.length - 1],
    waypoints: queries.slice(1, -1),
  });
  if (!retry.ok) {
    // Every stop resolved and the route still fails — find the pair that breaks and report where
    // each of those two stops actually landed.
    const brokenPair = await diagnoseUnroutable(resolution.stops, apiKey);
    return {
      ok: false,
      error: direct.error,
      policy: activePolicy,
      unresolved: resolution.unresolved,
      brokenPair,
      resolvedStops: resolution.stops
        .filter((s) => s.ok)
        .map((s) => ({ typed: s.typed, resolvedTo: s.formatted, approximate: s.approximate })),
    };
  }

  return { ...retry, approximatedStops: resolution.approximated };
}

module.exports = {
  DEFAULT_POLICY,
  VALID_POLICIES,
  normalizePolicy,
  getRoutePolicy,
  getGoogleApiKey,
  resolveRouteDistance,
  totalDistanceMeters,
  totalDurationSeconds,
};
