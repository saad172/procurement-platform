import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fixture } from './types';

/**
 * Finds and reads the committed fixtures.
 *
 * Discovery is by walking the directory rather than by a hand-kept list,
 * because a fixture that exists but is in nobody's list is a fixture that never
 * runs — and a replay suite whose coverage depends on someone remembering to
 * add a line is not a suite anyone should trust.
 */

export const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures');

/** Fixture names, e.g. `resolve/agree-r1`, in stable order. */
export async function listFixtureNames(dir = FIXTURE_DIR): Promise<string[]> {
  const names: string[] = [];

  async function walk(current: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // No fixtures recorded yet: an empty list, not an error.
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.json')) {
        names.push(`${prefix}${entry.name.slice(0, -'.json'.length)}`);
      }
    }
  }

  await walk(dir, '');
  return names;
}

export async function loadFixture(name: string, dir = FIXTURE_DIR): Promise<Fixture> {
  return JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as Fixture;
}
