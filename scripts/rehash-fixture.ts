// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { wireHash } from '@/model/wire';
import { serializeFixture } from '@/fixtures/record';
import { loadFixture, FIXTURE_DIR } from '@/fixtures/load';

/**
 * Recomputes a fixture's wire hashes from dumped request bodies.
 *
 *   MODEL_REQUEST_DUMP_DIR=/tmp/dump pnpm worker      # record with dumping on
 *   pnpm fixtures:rehash <name> /tmp/dump
 *
 * ## Why this exists
 *
 * A fixture stores a **hash** of each request, not the body — deliberately,
 * since a body is the whole conversation so far repeated once per turn. The
 * consequence is that changing *how a request is hashed* invalidates every
 * fixture just as thoroughly as changing what a request contains, and the only
 * remedy was **re-running every Job**: about forty-five minutes of pipeline,
 * and real tokens, to learn nothing new.
 *
 * That happened twice — once to normalise row ids, once to normalise row
 * instants — before it was worth automating.
 *
 * The dumps make it recoverable. Each file is named for the hash it had **when
 * it was written**, so recomputing under the new algorithm gives an
 * old → new mapping, and a fixture's turns can be rewritten without a single
 * model call.
 *
 * It cannot invent what was never dumped: a fixture whose run had dumping off
 * still needs re-running, and the script says which turns it could not map.
 */

async function main(): Promise<void> {
  const name = process.argv[2];
  const dumpDir = process.argv[3];
  if (!name || !dumpDir) {
    console.error('Usage: pnpm fixtures:rehash <name> <dumpDir>');
    process.exitCode = 1;
    return;
  }

  const fixture = await loadFixture(name);

  // filename (the hash as it was) → hash as it is now.
  const remap = new Map<string, string>();
  for (const file of await readdir(dumpDir)) {
    if (!file.endsWith('.json')) continue;
    const was = file.slice(0, -'.json'.length);
    remap.set(was, wireHash(await readFile(join(dumpDir, file), 'utf8')));
  }

  const unmapped: number[] = [];
  const turns = fixture.turns.map((turn) => {
    const next = turn.wireHash ? remap.get(turn.wireHash) : undefined;
    if (!next) {
      unmapped.push(turn.n);
      return turn;
    }
    return { ...turn, wireHash: next };
  });

  if (unmapped.length > 0) {
    console.error(
      `No dumped body for turn(s) ${unmapped.join(', ')} of "${name}". ` +
        'Those turns ran with dumping off, so the fixture has to be re-recorded from a fresh run.',
    );
    process.exitCode = 1;
    return;
  }

  await writeFile(join(FIXTURE_DIR, `${name}.json`), serializeFixture({ ...fixture, turns }));
  console.warn(`  ${name}: ${turns.length} turn(s) rehashed from ${remap.size} dumped bodies.`);
}

void main();
