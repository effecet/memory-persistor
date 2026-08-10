/**
 * Drizzle ORM schema for memory-persistor.
 *
 * Memory corpus: entities (memories), memory_relations (graph edges),
 * memory_versions (history), events (observability).
 * Separate from the corpus: pending (work queue) — see its comment below.
 */
import {
  pgTable,
  uuid,
  text,
  real,
  integer,
  timestamp,
  boolean,
  jsonb,
  index,
  check,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { PendingCategory, PendingPriority, PendingStatus } from './config.js';

// ── Entities (memories) ────────────────────────────────────────────────────

export const entities = pgTable('entities', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(), // user | project | decision | fact | pattern | feedback | reference
  observations: text('observations').default(''),
  tags: text('tags').array().default([]),
  source: text('source').notNull(), // CWD path where remember was invoked
  importance: real('importance').default(0.5),
  temperature: real('temperature').default(1.0),
  tier: text('tier').default('HOT'), // HOT | WARM | COLD (computed on write)
  accessCount: integer('access_count').default(0),
  accessBitmap: integer('access_bitmap').default(0),
  originHost: text('origin_host'),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  stale: boolean('stale').default(false),
  // Semantic embedding (bge-small-en-v1.5, fp32, 384-d, L2-normalized). Nullable:
  // write-disabled machines write NULL (dev-only-embed) and a primary backfills.
  // No ANN index — exact brute-force cosine (`<=>`) is sub-ms at this corpus size.
  embedding: vector('embedding', { dimensions: 384 }),
}, (table) => [
  index('idx_entities_type').on(table.type),
  index('idx_entities_temperature').on(table.temperature),
  index('idx_entities_tags').using('gin', table.tags),
]);

// ── Memory versions (audit trail) ──────────────────────────────────────────

export const memoryVersions = pgTable('memory_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  memoryId: uuid('memory_id').references(() => entities.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  observations: text('observations').default(''),
  tags: text('tags').array().default([]),
  importance: real('importance').default(0.5),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_versions_memory_id').on(table.memoryId),
  index('idx_versions_changed_at').on(table.changedAt),
]);

// ── Memory relations (graph edges) ─────────────────────────────────────────

export const memoryRelations = pgTable('memory_relations', {
  id: uuid('id').defaultRandom().primaryKey(),
  fromId: uuid('from_id').references(() => entities.id, { onDelete: 'cascade' }).notNull(),
  toId: uuid('to_id').references(() => entities.id, { onDelete: 'cascade' }).notNull(),
  relationType: text('relation_type').notNull(),
  weight: real('weight').default(1.0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_relations_from').on(table.fromId),
  index('idx_relations_to').on(table.toId),
]);

// ── Events (observability) ─────────────────────────────────────────────────

export const events = pgTable('events', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventType: text('event_type').notNull(),
  memoryId: uuid('memory_id'), // nullable
  payload: jsonb('payload').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_events_type').on(table.eventType),
  index('idx_events_memory_id').on(table.memoryId),
  index('idx_events_created_at').on(table.createdAt),
]);

// ── Pending (work queue) ───────────────────────────────────────────────────
//
// Deliberately NOT part of the memory corpus. Pending items are a queue with a
// lifecycle (open → done/archived), not thermally-decayed knowledge: no
// temperature, no embedding, no graph edges, no markdown mirror. Kept in the
// same database purely so the session-start hook needs one connection.

export const pending = pgTable('pending', {
  id: uuid('id').defaultRandom().primaryKey(),
  title: text('title').notNull(),
  body: text('body').default(''),
  // $type<> keeps the config.ts vocabularies on the inferred row type instead
  // of widening every consumer to bare `string`.
  category: text('category').$type<PendingCategory>().notNull(),
  priority: text('priority').$type<PendingPriority>().notNull().default('medium'),
  status: text('status').$type<PendingStatus>().notNull().default('open'),
  source: text('source'), // cwd where the item was raised
  originHost: text('origin_host'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolution: text('resolution'),
}, (table) => [
  index('idx_pending_status_priority').on(table.status, table.priority),
  // Mirrors the CHECK constraints in drizzle/0009_pending.sql. Declared here
  // too so a future `drizzle-kit generate` doesn't silently drop them — the
  // migration is hand-written, so the schema is the only place the generator
  // can learn they exist.
  check('pending_category_check', sql`${table.category} IN ('skill', 'rule', 'automation', 'knowledge')`),
  check('pending_priority_check', sql`${table.priority} IN ('low', 'medium', 'high')`),
  check('pending_status_check', sql`${table.status} IN ('open', 'done', 'archived')`),
]);
