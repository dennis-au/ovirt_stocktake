import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createPostgresPool } from "./postgres/client.js";
import { migratePostgres } from "./postgres/migrate.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const inventoryDb = createPostgresPool(config.postgres);

if (inventoryDb) {
  await migratePostgres(inventoryDb);
}

const app = buildApp({ db, config, inventoryDb });

app.addHook("onClose", async () => {
  await inventoryDb?.end();
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`ovirt-inventory listening on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
