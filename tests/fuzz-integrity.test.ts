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
    let shrunk = 0;
    let merged = 0;
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
      shrunk += run.result.stats.inputsShrunk + run.result.stats.textsShrunk;
      if (run.session.some((m) => m.toolUses.length > 1 && !transcript.messages.includes(m as never))) merged += 1;
      if (seed % DETERMINISM_EVERY === 0) {
        const again = await runCase(seed, genTranscript(seed));
        if (fingerprint(again) !== fingerprint(run)) failures.push(`seed ${seed}: a second run gave a different output`);
      }
    }
    expect({ threw, failures: failures.slice(0, 25), total: failures.length }).toEqual({ threw: 0, failures: [], total: 0 });
    // Shortening (shrink.ts), parallel groups merged into one row included, is exercised.
    expect(shrunk).toBeGreaterThan(SEEDS / 10);
    expect(merged).toBeGreaterThan(0);
  }, Math.max(60_000, SEEDS * 100));
});
