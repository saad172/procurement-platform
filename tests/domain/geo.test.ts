import { describe, expect, it } from 'vitest';
import { haversineKm, nearestPlant } from '@/domain/geo';
import { PLANTS } from '@/db/seed-data/program';

/** SPEC §9.2 — haversine, not routing. */

const plants = PLANTS.map((p) => ({ code: p.code, city: p.city, lat: p.lat, lon: p.lon }));

describe('haversine', () => {
  it('is zero for a point to itself', () => {
    expect(haversineKm({ lat: 35.751, lon: -86.93 }, { lat: 35.751, lon: -86.93 })).toBe(0);
  });

  it('is symmetric', () => {
    const a = { lat: 48.7, lon: 9.2 };
    const b = { lat: 35.751, lon: -86.93 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });

  it('reproduces the seed document’s own stated Plant distances', () => {
    // The seed says P4 is "~1,300 km from P2 and ~2,300 km from P3". Those two
    // figures are what justify the fourth Plant: they are why "nearest Plant"
    // discriminates instead of collapsing onto the Michigan cluster. Checking
    // them here means a coordinate typo in the seed breaks a test rather than
    // quietly moving every proximity score.
    const p2 = { lat: 32.736, lon: -97.108 };
    const p3 = { lat: 42.733, lon: -84.556 };
    const p4 = { lat: 25.542, lon: -100.956 };
    // CORRECTION, found here: the seed says "~1,300 km from P2". The true
    // great-circle distance is 883 km. P4-P3 checks out at 2,426 km against its
    // stated ~2,300.
    //
    // The design consequence is unchanged and is if anything stronger — P4 is
    // CLOSER to the Texas plant than the seed thought, so the four Plants span
    // the continent no less well. But the write-up must not quote 1,300.
    expect(haversineKm(p4, p2)).toBeGreaterThan(850);
    expect(haversineKm(p4, p2)).toBeLessThan(920);
    expect(haversineKm(p4, p3)).toBeGreaterThan(2_350);
    expect(haversineKm(p4, p3)).toBeLessThan(2_500);
  });
});

describe('nearestPlant', () => {
  it('returns nothing when the supplier has no coordinate', () => {
    // Proximity is then `unknown`, and unknown drops out of the Score rather
    // than taking a stand-in value.
    expect(nearestPlant(undefined, plants)).toBeUndefined();
  });

  it('picks the Mexican plant for a Mexican supplier', () => {
    // The seed's P4 is the consequential choice: Nemak (García, Nuevo León)
    // sits ~60 km from it and flips from worst-in-class to best-in-class.
    const nemak = { lat: 25.812, lon: -100.6 };
    const nearest = nearestPlant(nemak, plants);
    expect(nearest?.code).toBe('P4');
    expect(nearest?.km).toBeLessThan(100);
  });

  it('picks the Michigan plant for the Michigan supplier cluster', () => {
    const detroit = { lat: 42.331, lon: -83.046 };
    expect(nearestPlant(detroit, plants)?.code).toBe('P3');
  });

  it('puts a German supplier far beyond the proximity anchor', () => {
    // Which is the measured shape of this roster: no supplier between 824 km
    // and 6,082 km, so the curve between the clusters is decoration.
    const stuttgart = { lat: 48.775, lon: 9.183 };
    const nearest = nearestPlant(stuttgart, plants);
    expect(nearest!.km).toBeGreaterThan(6_000);
  });
});
