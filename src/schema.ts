/**
 * Drizzle ORM schema for memory-persistor.
 * Two tables: entities (memories) and memory_relations (graph edges).
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
} from 'drizzle-orm/pg-core';

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
