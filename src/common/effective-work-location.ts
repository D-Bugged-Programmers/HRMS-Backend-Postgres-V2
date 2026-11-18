// Effective work location of an employee: the per-employee override (User.workLocationId) wins, otherwise the
// department's location. Pure helper so geofence, attendance and statutory-state resolution share one rule.
export function effectiveWorkLocation<T>(employee: {
  workLocation?: T | null;
  department?: { workLocation?: T | null } | null;
}): T | null {
  return employee.workLocation ?? employee.department?.workLocation ?? null;
}

// The geo-fence a punch is checked against: the effective work location, but only when that location has its geo-fence on.
// A location with the fence off is just an address (state / city), so nobody is held to it.
export function effectiveGeoFence<
  T extends { geoFenceEnabled?: boolean },
>(employee: {
  workLocation?: T | null;
  department?: { workLocation?: T | null } | null;
}): T | null {
  const location = effectiveWorkLocation(employee);
  return location && location.geoFenceEnabled !== false ? location : null;
}
