import type { AppConfig } from "./config.js";
import { decryptSecret } from "./credentials.js";
import type { SqliteDatabase } from "./db.js";
import { collectOvirtCapacityMetrics, type OvirtCollectionTarget } from "./ovirt.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
import { insertMetricSamples, type MetricSample } from "./postgres/metrics.js";

interface ManagerCredentialRecord {
  id: string;
  name: string;
  url: string;
  ignore_tls: number;
  username_ciphertext: string;
  password_ciphertext: string;
}

export interface MetricsCollectionResult {
  managerId: string;
  managerName: string;
  collectedAt: string;
  sampleCount: number;
  warnings: Array<{ message: string; resource?: string }>;
  errors: Array<{ message: string; resource?: string }>;
}

export function metricsStorageEnabled(config: AppConfig, inventoryDb?: ConnectablePostgres): boolean {
  return Boolean(inventoryDb && ["postgres", "timescale", "timescaledb"].includes(config.metrics.backend));
}

export async function collectEnabledManagerMetrics(
  db: SqliteDatabase,
  config: AppConfig,
  inventoryDb?: ConnectablePostgres
): Promise<MetricsCollectionResult[]> {
  requireMetricsConfiguration(config, inventoryDb);
  const results: MetricsCollectionResult[] = [];
  for (const manager of listEnabledManagers(db)) {
    results.push(await collectAndStoreManagerMetrics(manager, config, inventoryDb));
  }
  return results;
}

export async function collectAndStoreManagerMetrics(
  manager: ManagerCredentialRecord,
  config: AppConfig,
  inventoryDb?: ConnectablePostgres
): Promise<MetricsCollectionResult> {
  requireMetricsConfiguration(config, inventoryDb);
  const collectedAt = new Date().toISOString();
  let target: OvirtCollectionTarget;
  try {
    target = {
      managerId: manager.id,
      managerName: manager.name,
      managerUrl: manager.url,
      username: decryptSecret(manager.username_ciphertext, config.credentialEncryptionKey as string),
      password: decryptSecret(manager.password_ciphertext, config.credentialEncryptionKey as string)
    };
  } catch {
    return {
      managerId: manager.id,
      managerName: manager.name,
      collectedAt,
      sampleCount: 0,
      warnings: [],
      errors: [{ message: "Stored oVirt credentials could not be decrypted" }]
    };
  }

  const collection = await collectOvirtCapacityMetrics(target, {
    allowInsecureTls: config.ovirtAllowInsecureTls || Boolean(manager.ignore_tls)
  });
  await ensureManager(inventoryDb as ConnectablePostgres, manager);
  const samples: MetricSample[] = collection.samples.map((sample) => ({
    managerId: manager.id,
    resourceType: sample.resourceType,
    resourceId: sample.resourceId,
    metricName: sample.metricName,
    sampledAt: collection.collectedAt,
    value: sample.value,
    labels: sample.labels
  }));
  await insertMetricSamples(inventoryDb as ConnectablePostgres, samples);

  return {
    managerId: manager.id,
    managerName: manager.name,
    collectedAt: collection.collectedAt,
    sampleCount: samples.length,
    warnings: collection.warnings,
    errors: collection.errors
  };
}

function requireMetricsConfiguration(config: AppConfig, inventoryDb?: ConnectablePostgres): asserts inventoryDb is ConnectablePostgres {
  if (!config.credentialEncryptionKey) {
    throw new Error("OVIRT_INVENTORY_ENCRYPTION_KEY is required");
  }
  if (!metricsStorageEnabled(config, inventoryDb)) {
    throw new Error("Capacity metrics require a PostgreSQL metrics backend");
  }
}

function listEnabledManagers(db: SqliteDatabase): ManagerCredentialRecord[] {
  return db
    .prepare(
      "SELECT id, name, url, ignore_tls, username_ciphertext, password_ciphertext FROM managers WHERE enabled = 1 ORDER BY name COLLATE NOCASE"
    )
    .all() as ManagerCredentialRecord[];
}

async function ensureManager(inventoryDb: ConnectablePostgres, manager: ManagerCredentialRecord): Promise<void> {
  await inventoryDb.query(
    `
      INSERT INTO managers (id, name, url, credential_status)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        credential_status = excluded.credential_status,
        updated_at = CURRENT_TIMESTAMP
    `,
    [manager.id, manager.name, manager.url, "saved"]
  );
}
