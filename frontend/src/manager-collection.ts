export type CollectableManager = {
  id: string;
  name: string;
  enabled: boolean;
};

export type SequentialCollectionFailure = {
  managerId: string;
  managerName: string;
};

export async function collectManagersSequentially<T>(
  managers: readonly CollectableManager[],
  collect: (manager: CollectableManager) => Promise<T>,
  onStart?: (manager: CollectableManager, index: number, total: number) => void
): Promise<{ snapshots: T[]; failures: SequentialCollectionFailure[] }> {
  const enabledManagers = managers.filter((manager) => manager.enabled);
  const snapshots: T[] = [];
  const failures: SequentialCollectionFailure[] = [];

  for (const [index, manager] of enabledManagers.entries()) {
    onStart?.(manager, index, enabledManagers.length);
    try {
      snapshots.push(await collect(manager));
    } catch {
      failures.push({ managerId: manager.id, managerName: manager.name });
    }
  }

  return { snapshots, failures };
}
