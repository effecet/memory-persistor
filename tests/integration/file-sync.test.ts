/**
 * Integration tests for the file-sync (dual-write to markdown) subsystem.
 * Uses a unique temp source path to avoid touching real memory files.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { syncToFile, removeFile, encodeProjectPath } from '../../src/file-sync.js';
import { CLAUDE_DIR } from '../../src/config.js';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  insertTestMemory,
  cleanupMemories,
  closeTestDb,
} from './helpers.js';

const TEST_SOURCE = `/tmp/test-integration-filesync-${Date.now()}`;
const encodedDir = join(
  CLAUDE_DIR,
  'projects',
  encodeProjectPath(TEST_SOURCE),
  'memory',
);

const createdIds: string[] = [];

describe('file-sync integration', () => {
  afterAll(async () => {
    // Remove the entire test memory directory
    const projectDir = join(CLAUDE_DIR, 'projects', encodeProjectPath(TEST_SOURCE));
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }

    await cleanupMemories(createdIds);
    await closeTestDb();
  });

  it('syncToFile creates markdown with correct frontmatter', async () => {
    const entity = await insertTestMemory({
      name: 'file-sync-test-create',
      type: 'fact',
      observations: 'Integration test for markdown file creation',
      source: TEST_SOURCE,
      temperature: 0.8,
      tier: 'HOT',
    });
    createdIds.push(entity.id);

    syncToFile({
      id: entity.id,
      name: 'file-sync-test-create',
      type: 'fact',
      observations: 'Integration test for markdown file creation',
      source: TEST_SOURCE,
      temperature: 0.8,
      tier: 'HOT',
    });

    const filePath = join(encodedDir, 'fact_file-sync-test-create.md');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('name: file-sync-test-create');
    expect(content).toContain('type: fact');
    expect(content).toContain('temperature: 0.8');
    expect(content).toContain('tier: HOT');
    expect(content).toContain(`pg_id: ${entity.id}`);
    expect(content).toContain('Integration test for markdown file creation');
  });

  it('syncToFile updates existing file', async () => {
    const entity = await insertTestMemory({
      name: 'file-sync-test-update',
      type: 'project',
      observations: 'First version of observations',
      source: TEST_SOURCE,
      temperature: 0.6,
      tier: 'WARM',
    });
    createdIds.push(entity.id);

    // First write
    syncToFile({
      id: entity.id,
      name: 'file-sync-test-update',
      type: 'project',
      observations: 'First version of observations',
      source: TEST_SOURCE,
      temperature: 0.6,
      tier: 'WARM',
    });

    // Second write with updated observations
    syncToFile({
      id: entity.id,
      name: 'file-sync-test-update',
      type: 'project',
      observations: 'Second version of observations with new content',
      source: TEST_SOURCE,
      temperature: 0.9,
      tier: 'HOT',
    });

    const filePath = join(encodedDir, 'project_file-sync-test-update.md');
    const content = readFileSync(filePath, 'utf-8');

    // Should contain the second version, not the first
    expect(content).toContain('Second version of observations with new content');
    expect(content).not.toContain('First version of observations');
    expect(content).toContain('temperature: 0.9');
    expect(content).toContain('tier: HOT');
  });

  it('removeFile deletes the markdown file', async () => {
    const entity = await insertTestMemory({
      name: 'file-sync-test-remove',
      type: 'decision',
      observations: 'This file should be deleted',
      source: TEST_SOURCE,
      temperature: 0.5,
      tier: 'WARM',
    });
    createdIds.push(entity.id);

    const entityPayload = {
      id: entity.id,
      name: 'file-sync-test-remove',
      type: 'decision',
      observations: 'This file should be deleted',
      source: TEST_SOURCE,
      temperature: 0.5,
      tier: 'WARM',
    };

    // Create the file first
    syncToFile(entityPayload);
    const filePath = join(encodedDir, 'decision_file-sync-test-remove.md');
    expect(existsSync(filePath)).toBe(true);

    // Remove it
    removeFile(entityPayload);
    expect(existsSync(filePath)).toBe(false);
  });
});
