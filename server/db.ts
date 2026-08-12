import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

export function openDatabase(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_sessions (
      id_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS managers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      ignore_tls INTEGER NOT NULL DEFAULT 0,
      username_ciphertext TEXT NOT NULL,
      password_ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      manager_id TEXT NOT NULL,
      manager_name TEXT NOT NULL,
      manager_url TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      api_version TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success', 'partial', 'failed')),
      resources_json TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      errors_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_manager_collected
      ON snapshots (manager_id, collected_at DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_created
      ON audit_logs (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
      ON audit_logs (action, created_at DESC);

    CREATE TABLE IF NOT EXISTS saved_views (
      id TEXT PRIMARY KEY,
      owner_username TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      columns_json TEXT NOT NULL,
      sort_json TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_saved_views_owner_scope
      ON saved_views (owner_username, scope);

    INSERT INTO app_metadata (key, value)
    VALUES ('schema_version', '3')
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP;
  `);

  addColumnIfMissing(db, "app_sessions", "role", "TEXT NOT NULL DEFAULT 'admin'");
  addColumnIfMissing(db, "managers", "ignore_tls", "INTEGER NOT NULL DEFAULT 0");
}

export function databaseHealth(db: SqliteDatabase): { ok: true; schemaVersion: string } {
  const row = db
    .prepare("SELECT value FROM app_metadata WHERE key = ?")
    .get("schema_version") as { value: string } | undefined;

  if (!row?.value) {
    throw new Error("database schema metadata is missing");
  }

  return { ok: true, schemaVersion: row.value };
}

function addColumnIfMissing(db: SqliteDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.every((existing) => existing.name !== column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}
