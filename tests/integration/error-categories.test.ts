import { closeTestDb, insertTestMemory, cleanupMemory } from './helpers.js';
import { describe, it, expect, afterAll } from 'vitest';
import { CategorizedError } from '../../src/errors.js';
import { updatePending } from '../../src/pending.js';
import { mergeMemories } from '../../src/intelligence.js';

// helpers.js is imported FIRST: it points DOTENV_CONFIG_PATH at the test
// database before src/db.ts builds its pool (see helpers.ts:10-23).

const MISSING = '00000000-0000-4000-8000-000000000001';

async function categoryOfRejection(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CategorizedError);
  return (err as CategorizedError).category;
}

afterAll(async () => {
  await closeTestDb();
});

describe('library error categories', () => {
  it('updatePending with an empty title is validation', async () => {
    expect(await categoryOfRejection(updatePending(MISSING, { title: '   ' }))).toBe('validation');
  });

  it('updatePending with no fields is validation', async () => {
    expect(await categoryOfRejection(updatePending(MISSING, {}))).toBe('validation');
  });

  it('mergeMemories with an unknown id is validation', async () => {
    const real = await insertTestMemory({ name: 'error-categories merge target' });
    try {
      expect(await categoryOfRejection(mergeMemories(MISSING, real.id))).toBe('validation');
    } finally {
      await cleanupMemory(real.id);
    }
  });
});
