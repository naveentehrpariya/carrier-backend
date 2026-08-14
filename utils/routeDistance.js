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

// Google names a route by its dominant highway ("Trans-Canada Hwy"). On a multi-leg request that
// name is often blank, and an unnamed route on screen is indistinguishable from every other one —
// so fall back to a positional label rather than rendering an empty chip.
function routeLabel(route, index) {
  const summary = String(route?.summary || '').trim();
  return summary || `Route ${index + 1}`;
}

// One selectable route, flattened for the API/UI. `polyline` is Google's own encoded overview: the
// map draws THIS, never its own Directions call, so what the dispatcher picks is exactly what gets
// stored (a second browser-side measurement drifts — see the `_measuredKey` note in CLAUDE.md).
function describeRoute(entry, index) {
  return {
    index,
    summary: routeLabel(entry.route, index),
    meters: entry.info.distanceMeters,
    km: Number((entry.info.distanceMeters / 1000).toFixed(2)),
    miles: Number((entry.info.distanceMeters / 1609.344).toFixed(2)),
    durationSeconds: entry.info.durationSeconds,
    crossesBorder: entry.info.crossesBorder,
    countries: entry.info.countries,
    polyline: entry.route?.overview_polyline?.points || '',
  };
}

/**
 * Resolve a route honouring the tenant's routing policy.
 *
 * Returns { ok, meters, km, miles, durationSeconds, crossesBorder, countries, homeCountry,
 *           policy, source, corridorUsed, summary, polyline, alternatives, error }
 *
 * `source`:
 *   'auto_fastest'  — policy off, or trip is genuinely cross-border: Google's best route
 *   'auto_domestic' — an alternative that stays inside the country was chosen
 *   'auto_corridor' — every alternative crossed, so domestic corridor waypoints were forced
 *
 * `alternatives` are the routes a dispatcher may legitimately choose between — already filtered by
 * policy, so a border-crossing route is never offered to a domestic_only tenant. Google only returns
 * more than one route when the request has NO waypoints, so a multi-stop order always yields exactly
 * one entry here. Measuring each stop pair separately to get around that is not an option: pairs sum
 * LONGER than the single connected route (CMC-1028: 1662.89 mi of legs vs 1419.68 mi of order).
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

  // What the dispatcher may pick between. Under domestic_only a border-crossing route is not a
  // choice — it is the mistake the policy exists to prevent — so it never reaches the picker.
  const eligible = (activePolicy === 'domestic_only' && homeCountry)
    ? analyzed.filter((a) => !a.info.crossesBorder)
    : analyzed;
  const selectable = [...eligible].sort((a, b) => a.info.distanceMeters - b.info.distanceMeters);

  const finish = (chosen, source, corridorUsed = null, options = selectable) => {
    const alternatives = options.map(describeRoute);
    const chosenPolyline = chosen.route?.overview_polyline?.points || '';
    const chosenIndex = Math.max(analyzed.indexOf(chosen), 0);
    return {
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
      summary: routeLabel(chosen.route, chosenIndex),
      polyline: chosenPolyline,
      alternatives: alternatives.map((alt) => ({
        ...alt,
        selected: alt.meters === chosen.info.distanceMeters && alt.polyline === chosenPolyline,
      })),
      error: null,
    };
  };

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
      // The corridor route came from a different request, so it is not one of `selectable` —
      // and there is nothing to choose between: it is the only route that stays in the country.
      const forced = { route: retry.routes[0], info: analyzeRoute(retry.routes[0], homeCountry) };
      return finish(forced, 'auto_corridor', corridor.name, [forced]);
    }
  }

  // No domestic option at all — return the fastest, flagged, so the UI can warn the dispatcher.
  // `selectable` is empty here (every route crossed), so offer the one actually being used rather
  // than an empty picker.
  return finish(best, 'auto_fastest', null, [best]);
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
