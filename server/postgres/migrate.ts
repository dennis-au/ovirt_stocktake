import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { postgresMigrations } from "./migrations.js";

export interface PostgresQueryable {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
}

type ConnectablePostgres = PostgresQueryable & {
  connect?: () => Promise<PoolClient>;
};

export async function migratePostgres(db: Pool | PostgresQueryable): Promise<void> {
  const target = db as ConnectablePostgres;

  if (target.connect) {
    const client = await target.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
    }
    return;
  }

  await runMigrations(target);
}

async function runMigrations(client: PostgresQueryable): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
  const appliedIds = new Set(applied.rows.map((row) => row.id));

  for (const migration of postgresMigrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}
