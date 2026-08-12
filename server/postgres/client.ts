import { Pool } from "pg";
import type { PostgresConfig } from "../config.js";

export function createPostgresPool(config: PostgresConfig): Pool | undefined {
  if (!config.databaseUrl) {
    return undefined;
  }

  return new Pool({
    connectionString: config.databaseUrl,
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined
  });
}
