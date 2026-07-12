// Single source of truth for distance + driver-pay math, shared across
// owner-operator salary and driver salary so every screen agrees.
//
// Canonical rules:
// - Order distance is stored in KM (order.totalDistance).
// - Real miles = km * MI_PER_KM. KM_PER_MI is the exact reciprocal so round-trips are stable.
// - A trip/segment's real miles are derived from the order's KM, proportioned by the trip's
//   raw distance share (NOT the legacy trip.miles field, which historically stored KM).
// - Driver rates are in USD. Team rate applies when a trip has >1 driver.

const MI_PER_KM = 0.621371;
const KM_PER_MI = 1.609344;

const milesToKm = (mi) => Number(mi || 0) * KM_PER_MI;
const kmToMiles = (km) => Number(km || 0) * MI_PER_KM;

// Fallback miles for a trip when order KM is unavailable. Handles legacy records where
// the unit is ambiguous or the value was stored in KM under a "miles" field.
function normalizeTripMiles(trip) {
  const unit = String(trip?.distance_unit || '').toLowerCase();
  const milesField = Number(trip?.miles || 0);
  const totalDistanceField = Number(trip?.totalDistance || 0);
  const totalKmField = Number(trip?.total_km || 0);

  if (unit === 'km') {
    const kmValue = totalKmField > 0 ? totalKmField : (totalDistanceField > 0 ? totalDistanceField : milesField);
    return kmValue > 0 ? kmToMiles(kmValue) : 0;
  }
  if (unit === 'mi') {
    if (milesField > 0) return milesField;
    if (totalDistanceField > 0) return totalDistanceField;
    if (totalKmField > 0) return kmToMiles(totalKmField);
    return 0;
  }
  if (milesField > 0) return milesField;
  if (totalKmField > 0) return kmToMiles(totalKmField);
  if (totalDistanceField > 0) return totalDistanceField;
  return 0;
}

// Real miles for one trip/segment, derived from the order's KM total and the trip's share.
// orderDistanceKm = order.totalDistance (km); orderRawTotal = sum of all trips' raw distance
// for that order (used only as a ratio, so its unit cancels out).
function deriveTripMiles(trip, orderDistanceKm, orderRawTotal) {
  const orderDistanceMiles = Number(orderDistanceKm) > 0 ? kmToMiles(orderDistanceKm) : 0;
  const rawDistance = Math.max(Number(trip?.totalDistance || trip?.miles || trip?.total_km || 0), 0);
  if (orderDistanceMiles > 0 && Number(orderRawTotal) > 0) {
    return (rawDistance / Number(orderRawTotal)) * orderDistanceMiles;
  }
  return normalizeTripMiles(trip);
}

// Per-mile rate for a driver on a trip: trip override wins, else team/solo profile rate.
// The number is denominated in getDriverRateCurrency(profile) — NOT necessarily USD.
function pickDriverRate(profile, isTeam, tripRateOverride) {
  const override = Number(tripRateOverride || 0);
  if (override > 0) return override;
  const solo = Number(profile?.ratePerMileSolo ?? profile?.ratePerMile ?? 0) || 0;
  const team = Number(profile?.ratePerMileTeam ?? profile?.ratePerMile ?? 0) || 0;
  return isTeam ? team : solo;
}

// Currency the driver's stored rates (and any trip rate_per_mile snapshot taken from them)
// are denominated in. Locked at creation; legacy profiles predate the field and were USD.
function getDriverRateCurrency(profile) {
  const code = String(profile?.rateCurrency || '').trim().toUpperCase();
  return ['USD', 'CAD', 'INR'].includes(code) ? code : 'USD';
}

module.exports = {
  MI_PER_KM,
  KM_PER_MI,
  milesToKm,
  kmToMiles,
  normalizeTripMiles,
  deriveTripMiles,
  pickDriverRate,
  getDriverRateCurrency,
};
