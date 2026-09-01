'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import {
  DEFAULT_WEIGHTS,
  WEIGHTED_CRITERIA,
  WEIGHT_PRESETS,
  type WeightVector,
} from '@/domain/score';
import { RESET_TO_DEFAULT_LABEL, historyModeFor } from '@/lib/view-state';

/**
 * The weight rail (SPEC §13.4).
 *
 * **Global and live wherever a Score is on the page; a read-only strip
 * everywhere else.** Stated by its reason rather than as a list of pages, so
 * Needs Review, the Leads table and the Runs branch inherit it without
 * re-deciding: *a control that visibly changes nothing is worse than no
 * control.*
 *
 * It writes to the URL and nowhere else. That is what makes an unsaved what-if
 * survive a reload, lets a ranking be shared without re-ranking under the
 * recipient's default, and means chat needs no `set_weights` tool — "set
 * compliance to 40" *is* a navigation.
 */

const LABELS: Record<string, string> = {
  compliance_risk: 'Compliance risk',
  ownership_exposure: 'Ownership exposure',
  country_resilience: 'Country resilience',
  tariff_exposure: 'Tariff exposure',
  proximity: 'Proximity',
  media_signal: 'Media signal',
};

type WeightRailProps = {
  programDefault: Required<WeightVector>;
  /** False where no Score is on the page — then it renders read-only. */
  live: boolean;
};

/**
 * Reads the live weight vector out of the URL, and writes a change back to it.
 *
 * `write` is the one place a slider, a preset or the reset chip ends up: every
 * gesture becomes a `Required<WeightVector>` plus its own name, and this is
 * what turns that into a URL.
 */
function useWeightRail(programDefault: Required<WeightVector>) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const weights = useMemo(() => {
    const out = { ...programDefault };
    for (const key of WEIGHTED_CRITERIA) {
      const raw = searchParams.get(`w.${key}`);
      const value = raw == null ? null : Number(raw);
      if (value != null && Number.isFinite(value) && value >= 0) out[key] = value;
    }
    return out;
  }, [searchParams, programDefault]);

  const isWhatIf = WEIGHTED_CRITERIA.some((key) => weights[key] !== programDefault[key]);
  const total = WEIGHTED_CRITERIA.reduce((sum, key) => sum + weights[key], 0);

  const write = useCallback(
    (next: Required<WeightVector>, gesture: 'drag' | 'preset' | 'navigate') => {
      const params = new URLSearchParams(searchParams.toString());
      for (const key of WEIGHTED_CRITERIA) {
        if (next[key] === programDefault[key]) params.delete(`w.${key}`);
        else params.set(`w.${key}`, String(next[key]));
      }
      const url = `${pathname}${params.toString() ? `?${params}` : ''}`;
      // A DISCRETE ACT PUSHES; A CONTINUOUS GESTURE REPLACES. One slider drag
      // must not bury the spine under twenty history entries.
      if (historyModeFor(gesture) === 'replace') router.replace(url as never, { scroll: false });
      else router.push(url as never, { scroll: false });
    },
    [pathname, router, searchParams, programDefault],
  );

  return { weights, isWhatIf, total, write };
}

export function WeightRail({ programDefault, live }: WeightRailProps) {
  const { weights, isWhatIf, total, write } = useWeightRail(programDefault);

  if (!live) {
    return (
      <section className="card" aria-label="Weights">
        <h3 style={{ marginTop: 0 }}>Weights</h3>
        <p className="note" style={{ margin: 0 }}>
          {WEIGHTED_CRITERIA.map((key) => `${LABELS[key]} ${weights[key]}`).join(' · ')}
        </p>
        <p className="note" style={{ marginTop: '0.4rem', opacity: 0.75 }}>
          Read-only here — nothing on this page is scored, and a control that visibly changes
          nothing is worse than no control.
        </p>
      </section>
    );
  }

  return (
    <section className="card" aria-label="Weight rail">
      <h3
        style={{
          marginTop: 0,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>Weights</span>
        <span className="note" style={{ fontWeight: 400 }}>
          sum {total}
        </span>
      </h3>

      <div className="rail">
        {WEIGHTED_CRITERIA.map((key) => (
          <div className="rail-row" key={key}>
            <label htmlFor={`w-${key}`}>{LABELS[key]}</label>
            <input
              id={`w-${key}`}
              type="range"
              min={0}
              max={50}
              step={1}
              value={weights[key]}
              onChange={(event) => write({ ...weights, [key]: Number(event.target.value) }, 'drag')}
            />
            <output htmlFor={`w-${key}`}>{weights[key]}</output>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.7rem', flexWrap: 'wrap' }}>
        {Object.entries(WEIGHT_PRESETS).map(([name, preset]) => (
          <button
            key={name}
            type="button"
            className="badge"
            style={{ cursor: 'pointer' }}
            onClick={() => write(preset, 'preset')}
          >
            {name}
          </button>
        ))}
      </div>

      {isWhatIf ? (
        <p style={{ marginTop: '0.7rem', marginBottom: 0 }}>
          {/*
            The transient chip. It compares the rail to the PROGRAMME DEFAULT and
            never reacts to a version — keeping the two comparisons apart is what
            stops a live rail permanently lighting a version's banner.
          */}
          <span className="chip">
            Viewing a what-if
            <button
              type="button"
              onClick={() => write(programDefault as Required<WeightVector>, 'navigate')}
              style={{
                background: 'none',
                border: 0,
                color: 'inherit',
                cursor: 'pointer',
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              {RESET_TO_DEFAULT_LABEL}
            </button>
          </span>
        </p>
      ) : (
        <p className="note" style={{ marginTop: '0.7rem', marginBottom: 0 }}>
          {/*
            "Save as Program default" is the ONE act separating a what-if from
            the record, and it stays UI-only — a person's judgement recorded,
            not a Job started.
          */}
          On the program default. Changing a slider makes a what-if that lives in the address bar,
          so it survives a reload and can be shared without re-ranking under someone else’s default.
        </p>
      )}
    </section>
  );
}

export { DEFAULT_WEIGHTS };
