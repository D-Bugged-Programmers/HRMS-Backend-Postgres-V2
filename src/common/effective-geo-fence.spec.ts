import { effectiveGeoFence } from './effective-work-location';

// A work location with its geo-fence switched off is only an address: nobody is held to it at punch time.
describe('effectiveGeoFence', () => {
  const on = { geoFenceEnabled: true };
  const off = { geoFenceEnabled: false };
  it('returns the effective location when its fence is on (or the flag is missing)', () => {
    expect(effectiveGeoFence({ workLocation: on })).toBe(on);
    expect(
      effectiveGeoFence({
        department: { workLocation: { geoFenceEnabled: undefined } },
      }),
    ).toEqual({});
  });
  it('returns null when the effective location has its fence off', () => {
    expect(effectiveGeoFence({ workLocation: off })).toBeNull();
    expect(effectiveGeoFence({ department: { workLocation: off } })).toBeNull();
  });
  it('the employee-level location wins over the department one', () => {
    expect(
      effectiveGeoFence({
        workLocation: off,
        department: { workLocation: on },
      }),
    ).toBeNull();
    expect(
      effectiveGeoFence({
        workLocation: on,
        department: { workLocation: off },
      }),
    ).toBe(on);
  });
  it('is null with no location at all', () => {
    expect(effectiveGeoFence({})).toBeNull();
  });
});
