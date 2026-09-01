import { z } from 'zod';

/**
 * Projections for the four non-Sayari sources.
 *
 * All four are keyless, and all four have a documented trap that the projection
 * or the endpoint definition has to account for. The traps are written down
 * here because each one produces a *silent* wrong answer rather than an error.
 */

// ── GLEIF ────────────────────────────────────────────────────────────────────

/**
 * GLEIF's JSON:API envelope.
 *
 * Two traps (SPEC §7.1):
 *
 * 1. **The country filter is ISO2, not ISO3.** `DEU` returns HTTP 200 with zero
 *    results, silently — which looks exactly like a clean negative. The
 *    endpoint definition converts before sending; this schema cannot help.
 * 2. **Name search hits only the native-script primary name.** Denso and
 *    Hyundai Mobis return zero on an English search. That is why the *exact LEI
 *    join* is the decisive check and name search is only a witness.
 */
const gleifAddress = z
  .object({
    language: z.string().nullish(),
    addressLines: z.array(z.string()).nullish(),
    city: z.string().nullish(),
    region: z.string().nullish(),
    country: z.string().nullish(),
    postalCode: z.string().nullish(),
  })
  .partial()
  .loose();

const gleifRecord = z
  .object({
    type: z.string().nullish(),
    id: z.string(),
    attributes: z
      .object({
        lei: z.string().nullish(),
        entity: z
          .object({
            legalName: z.object({ name: z.string().nullish() }).partial().loose().nullish(),
            legalAddress: gleifAddress.nullish(),
            headquartersAddress: gleifAddress.nullish(),
            status: z.string().nullish(),
            legalForm: z.unknown().nullish(),
            jurisdiction: z.string().nullish(),
          })
          .partial()
          .loose()
          .nullish(),
        registration: z
          .object({ status: z.string().nullish(), lastUpdateDate: z.string().nullish() })
          .partial()
          .loose()
          .nullish(),
      })
      .partial()
      .loose()
      .nullish(),
  })
  .loose();

/** The exact-LEI join returns one record; a name search returns an array. */
export const gleifOneSchema = z.object({ data: gleifRecord.nullish() }).loose();
export const gleifManySchema = z
  .object({
    data: z.array(gleifRecord).nullish(),
    meta: z.object({ pagination: z.unknown().nullish() }).partial().loose().nullish(),
  })
  .loose();

// ── World Bank ───────────────────────────────────────────────────────────────

/**
 * World Bank Indicators v2 returns a two-element array: `[pagination, rows]`.
 *
 * Three traps (SPEC §7.1):
 *
 * 1. **`mrnev=1` is the correct latest-value operator.** `mrv=1` returns nulls
 *    for late reporters — a null that reads as "no data" when the country has
 *    data, just not for the most recent year.
 * 2. **The familiar `PV.EST`-style WGI codes are archived.** Use `GOV_WGI_*`,
 *    which additionally expose an absolute 0–100 `.SC` with confidence bounds —
 *    and the bounds are what let the UI render a band rather than a false point.
 * 3. **Doing Business is dead with no successor**, so LPI carries the logistics
 *    half alone.
 */
const worldBankRow = z
  .object({
    indicator: z
      .object({ id: z.string().nullish(), value: z.string().nullish() })
      .partial()
      .loose()
      .nullish(),
    country: z
      .object({ id: z.string().nullish(), value: z.string().nullish() })
      .partial()
      .loose()
      .nullish(),
    countryiso3code: z.string().nullish(),
    date: z.string().nullish(),
    value: z.number().nullish(),
    unit: z.string().nullish(),
    obs_status: z.string().nullish(),
    decimal: z.number().nullish(),
  })
  .loose();

export const worldBankSchema = z.union([
  z.tuple([
    z.object({ page: z.number().nullish(), total: z.number().nullish() }).partial().loose(),
    z.array(worldBankRow).nullable(),
  ]),
  // An error response is a one-element array of messages, not a tuple.
  z.tuple([
    z
      .object({ message: z.array(z.unknown()).nullish() })
      .partial()
      .loose(),
  ]),
]);

// ── USITC HTS ────────────────────────────────────────────────────────────────

/**
 * USITC's HTS `reststop` search.
 *
 * The trap is granularity, not shape: **`8708.99` is a trap at 6 digits** — its
 * lines run Free (tractor parts, cast iron, power-train parts) to 2.5%
 * (everything else), so a 6-digit cache entry is a wrong number wearing a right
 * one's clothes. The seed carries 8- and 10-digit lines for exactly this
 * reason, and `8419.50` is the same story in reverse: Free at the heading, 4.2%
 * at the battery cold-plate sub-line.
 */
export const usitcSchema = z.union([
  z.array(
    z
      .object({
        htsno: z.string().nullish(),
        description: z.string().nullish(),
        general: z.string().nullish(),
        special: z.string().nullish(),
        other: z.string().nullish(),
        units: z.array(z.string()).nullish(),
        indent: z.union([z.string(), z.number()]).nullish(),
      })
      .loose(),
  ),
  z.object({ results: z.array(z.unknown()).nullish() }).loose(),
]);

// ── Nominatim ────────────────────────────────────────────────────────────────

/**
 * Nominatim search results.
 *
 * `addresstype` / `class` / `type` are what the precision level is derived
 * from, and recording precision is not optional: **4 of 6 sampled addresses
 * missed at building precision** (SPEC §7.1). A city centroid rendered as a
 * point would assert accuracy the data does not have.
 */
export const nominatimSchema = z.array(
  z
    .object({
      place_id: z.union([z.string(), z.number()]).nullish(),
      lat: z.string().nullish(),
      lon: z.string().nullish(),
      display_name: z.string().nullish(),
      class: z.string().nullish(),
      type: z.string().nullish(),
      addresstype: z.string().nullish(),
      importance: z.number().nullish(),
      boundingbox: z.array(z.string()).nullish(),
    })
    .loose(),
);

/** Photon's GeoJSON fallback, used when Nominatim returns nothing usable. */
export const photonSchema = z
  .object({
    features: z
      .array(
        z
          .object({
            geometry: z
              .object({ coordinates: z.array(z.number()).nullish() })
              .partial()
              .loose()
              .nullish(),
            properties: z.record(z.string(), z.unknown()).nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();
