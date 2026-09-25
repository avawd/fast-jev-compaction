/**
 * Transcript integrity over seeded, engine-shaped transcripts, driven through the real pipeline
 * (compact + makeScorer with a fake fork that answers, refuses, times out, throws and lies).
 * `npm test` runs 300 seeds; `FUZZ_SEEDS=5000 npx vitest run tests/fuzz-integrity.test.ts` a long run.
 * A failing seed prints its violations; reproduce it with `runCase(seed)` from fuzz-check.ts.
 */
import { describe, expect, it } from 'vitest';
import { checkCase, fingerprint, runCase } from './fuzz-check.ts';
import { genTranscript, seedCount } from './fuzz-gen.ts';

const SEEDS = seedCount(300);
/** Every seed is re-run once in this many to prove the output is a function of the seed. */
const DETERMINISM_EVERY = 3;

describe('fuzz: transcript integrity', () => {
  it(`holds every invariant over ${SEEDS} seeds`, async () => {
    const failures: string[] = [];
    let threw = 0;
    // The teammate-row pass (user-rows.ts) must actually run: each of its cuts on some seed.
    const cuts = { restated: 0, repeated: 0, stale: 0, notices: 0 };
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const transcript = genTranscript(seed);
      let run;
      try {
        run = await runCase(seed, transcript);
      } catch (error) {
        threw += 1;
        failures.push(`seed ${seed}: pipeline threw ${(error as Error).stack ?? String(error)}`);
        continue;
      }
      for (const f of checkCase(transcript, run)) failures.push(`seed ${seed}: ${f}`);
      const users = run.result.stats.userRows;
      if (users) for (const k of Object.keys(cuts) as Array<keyof typeof cuts>) cuts[k] += users[k] > 0 ? 1 : 0;
      if (seed % DETERMINISM_EVERY === 0) {
        const again = await runCase(seed, genTranscript(seed));
        if (fingerprint(again) !== fingerprint(run)) failures.push(`seed ${seed}: a second run gave a different output`);
      }
    }
    expect({ threw, failures: failures.slice(0, 25), total: failures.length }).toEqual({ threw: 0, failures: [], total: 0 });
    for (const [k, n] of Object.entries(cuts)) expect(n, `seeds with a ${k} cut`).toBeGreaterThan(SEEDS / 50);
  }, Math.max(60_000, SEEDS * 100));
});
