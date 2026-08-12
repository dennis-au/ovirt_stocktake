import type { SqliteDatabase } from "./db.js";

declare module "fastify" {
  interface FastifyInstance {
    sqlite: SqliteDatabase;
  }
}
