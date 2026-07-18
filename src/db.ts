import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** A better-sqlite3 database instance. */
export type DB = Database.Database;

export const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "app.db");

/**
 * Versioned, idempotent migrations. Each migration runs exactly once, in a
 * transaction, and bumps SQLite's `user_version`. Re-running is a no-op; adding
 * a new schema change means appending a migration with the next version — never
 * editing an already-applied one.
 */
interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    // §7 schema, verbatim in intent.
    sql: `
      CREATE TABLE accounts (
        handle              TEXT PRIMARY KEY,
        display_name        TEXT,
        weight              REAL DEFAULT 1.0,   -- interaction priority; grows as I reply
        added_at            TEXT NOT NULL,
        last_interacted_at  TEXT
      );

      CREATE TABLE tweets (
        id               TEXT PRIMARY KEY,
        author_handle    TEXT NOT NULL,
        text             TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        url              TEXT NOT NULL,
        like_count       INTEGER DEFAULT 0,
        reply_count      INTEGER DEFAULT 0,
        repost_count     INTEGER DEFAULT 0,
        quote_count      INTEGER DEFAULT 0,
        is_reply         INTEGER DEFAULT 0,
        is_repost        INTEGER DEFAULT 0,
        conversation_id  TEXT,
        raw_json         TEXT,                   -- full payload, so the agent has thread context
        fetched_at       TEXT NOT NULL,
        status           TEXT DEFAULT 'seen'     -- seen | candidate | drafted | posted | skipped
      );

      CREATE TABLE drafts (
        tweet_id     TEXT NOT NULL,
        draft_index  INTEGER NOT NULL,
        reply_text   TEXT NOT NULL,
        rationale    TEXT,
        chosen       INTEGER DEFAULT 0,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (tweet_id, draft_index)
      );

      CREATE TABLE actions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id    TEXT NOT NULL,
        action      TEXT NOT NULL,               -- posted | skipped
        reply_text  TEXT,
        acted_at    TEXT NOT NULL
      );

      CREATE TABLE runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL,              -- ingest | candidates | calibrate
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        stats_json   TEXT
      );

      CREATE INDEX idx_tweets_status  ON tweets(status);
      CREATE INDEX idx_tweets_author  ON tweets(author_handle);
      CREATE INDEX idx_tweets_created ON tweets(created_at);
    `,
  },
  {
    version: 2,
    name: "bucketing",
    // PLANNING.md §2: tweets get one primary bucket label (classified once by
    // the agent, persisted forever); account_buckets holds the derived rolling
    // profile per author (fully recomputed on every buckets:apply).
    sql: `
      ALTER TABLE tweets ADD COLUMN bucket TEXT;

      CREATE TABLE account_buckets (
        handle       TEXT NOT NULL,               -- lowercase
        bucket       TEXT NOT NULL,
        share        REAL NOT NULL,               -- 0..1, sums to ~1 per handle
        tweet_count  INTEGER NOT NULL,            -- labeled tweets behind this share
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (handle, bucket)
      );

      CREATE INDEX idx_tweets_bucket ON tweets(bucket);
    `,
  },
];

export interface MigrationResult {
  from: number;
  to: number;
  applied: Array<{ version: number; name: string }>;
}

/** Apply any pending migrations. Idempotent — safe to call on every startup. */
export function migrate(db: DB): MigrationResult {
  const from = db.pragma("user_version", { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > from).sort(
    (a, b) => a.version - b.version,
  );

  for (const m of pending) {
    const run = db.transaction(() => {
      db.exec(m.sql);
      // PRAGMA can't be parameterized; version is an integer literal we control.
      db.pragma(`user_version = ${m.version}`);
    });
    run();
  }

  const to = db.pragma("user_version", { simple: true }) as number;
  return { from, to, applied: pending.map((m) => ({ version: m.version, name: m.name })) };
}

let instance: DB | null = null;

/**
 * Open (once) the app database, set safe pragmas, and run migrations. Returns a
 * process-wide singleton. `data/` is created if missing.
 */
export function getDb(dbPath: string = DEFAULT_DB_PATH): DB {
  if (instance) return instance;
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); // concurrent reads while writing; durable
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  instance = db;
  return db;
}

/** Close the singleton (mainly for tests / clean shutdown). */
export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
