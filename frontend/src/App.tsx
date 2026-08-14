import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  ChartLine,
  Clock,
  Database,
  Download,
  GripVertical,
  HardDrive,
  History,
  LayoutDashboard,
  ArrowLeft,
  LogIn,
  LogOut,
  Menu,
  Network,
  PackageSearch,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Save,
  Server,
  Settings,
  Waypoints,
  XCircle
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";
import {
  collectAllManagers,
  collectManager,
  createSavedView,
  createManager,
  deleteManager,
  getDashboard,
  getDashboardCluster,
  getRelationships,
  getSettings,
  getSnapshot,
  getSnapshotVmInventory,
  getSession,
  listSavedViews,
  listManagers,
  listSnapshots,
  login,
  logout,
  snapshotVmInventoryExportUrl,
  testManagerCollection,
  updateManager,
  updateSettings,
  updateSavedView,
  type AppSettings,
  type DashboardClusterDetail,
  type DashboardClusterSummary,
  type DashboardClusterVm,
  type DashboardResponse,
  type SavedView,
  type Manager,
  type ManagerInput,
  type ManagerTestCollectionResult,
  type RelationshipResponse,
  type SnapshotDetail,
  type SnapshotSummary,
  type SnapshotVmInventoryFilters,
  type SnapshotVmInventoryResponse,
  type SnapshotVmInventoryRow,
  type SnapshotVmInventorySortDirection,
  type SnapshotVmInventorySortKey,
  type SessionResponse
} from "./api";
import appPackage from "../../package.json";
import { RelationshipReportBuilder } from "./RelationshipReportBuilder";
import { CapacityPage } from "./CapacityPage";

type PageId = "dashboard" | "inventory" | "capacity" | "relationships" | "managers" | "history" | "settings" | "cluster";
type SnapshotFilters = { managerId: string; status: string };
type InventoryColumnKey =
  | "managerName"
  | "clusterName"
  | "name"
  | "powerState"
  | "host"
  | "guestOs"
  | "ipAddress"
  | "vcpuCount"
  | "allocatedRamMiB"
  | "storage"
  | "snapshots"
  | "collectedAt";
type InventoryColumn = {
  key: InventoryColumnKey;
  label: string;
  sortable?: SnapshotVmInventorySortKey;
  className?: string;
  render: (vm: SnapshotVmInventoryRow) => string;
};

const inventorySavedViewScope = "inventory.vms";
const inventoryColumns: InventoryColumn[] = [
  { key: "managerName", label: "Manager", sortable: "managerName", render: (vm) => vm.managerName },
  { key: "clusterName", label: "Cluster", sortable: "clusterName", render: (vm) => vm.clusterName ?? "-" },
  { key: "name", label: "VM Name", sortable: "name", className: "wrap-cell strong-cell", render: (vm) => vm.name },
  { key: "powerState", label: "Power State", sortable: "powerState", className: "state-cell", render: (vm) => vm.powerState ?? "-" },
  { key: "host", label: "Host", sortable: "host", className: "wrap-cell", render: (vm) => vm.host ?? "-" },
  { key: "guestOs", label: "Guest OS", sortable: "guestOs", className: "wrap-cell", render: (vm) => vm.guestOs ?? "-" },
  { key: "ipAddress", label: "IP Addresses", sortable: "ipAddress", className: "wrap-cell ip-cell", render: formatIpAddresses },
  { key: "vcpuCount", label: "vCPU Count", sortable: "vcpuCount", className: "numeric-cell", render: (vm) => formatNumber(vm.vcpuCount) },
  {
    key: "allocatedRamMiB",
    label: "Allocated RAM",
    sortable: "allocatedRamMiB",
    className: "numeric-cell",
    render: (vm) => formatMemory(vm.allocatedRamMiB)
  },
  { key: "storage", label: "Storage Allocated / Used", sortable: "storageAllocatedGiB", className: "numeric-cell", render: formatVmStorage },
  { key: "snapshots", label: "Snapshots", className: "wrap-cell", render: formatSnapshotNames },
  { key: "collectedAt", label: "Collected", sortable: "collectedAt", className: "date-cell", render: (vm) => new Date(vm.collectedAt).toLocaleString() }
];
const defaultInventoryColumnOrder = inventoryColumns.map((column) => column.key);

const pageTitles: Record<PageId, string> = {
  dashboard: "Overview",
  inventory: "Inventory",
  capacity: "Capacity",
  relationships: "Topology",
  managers: "Managers",
  history: "Snapshot History",
  settings: "Settings",
  cluster: "Cluster Detail"
};

export function App() {
  const [session, setSession] = useState<SessionResponse>({ authenticated: false });
  const [authStatus, setAuthStatus] = useState<"checking" | "ready">("checking");
  const [activePage, setActivePage] = useState<PageId>(() => pageFromHash());
  const [routeHash, setRouteHash] = useState(() => window.location.hash);
  const [loginError, setLoginError] = useState("");
  const [loginPending, setLoginPending] = useState(false);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [managerError, setManagerError] = useState("");
  const [managerMessage, setManagerMessage] = useState("");
  const [editingManager, setEditingManager] = useState<Manager | undefined>();
  const [testCollectionResult, setTestCollectionResult] = useState<ManagerTestCollectionResult | undefined>();
  const [testCollectionPending, setTestCollectionPending] = useState(false);
  const [collectionBusyId, setCollectionBusyId] = useState<string | undefined>();
  const [collectedSnapshot, setCollectedSnapshot] = useState<SnapshotDetail | undefined>();
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState<SnapshotDetail | undefined>();
  const [snapshotFilters, setSnapshotFilters] = useState<SnapshotFilters>({ managerId: "", status: "" });
  const [snapshotError, setSnapshotError] = useState("");
  const [dashboard, setDashboard] = useState<DashboardResponse | undefined>();
  const [dashboardError, setDashboardError] = useState("");
  const [clusterDetail, setClusterDetail] = useState<DashboardClusterDetail | undefined>();
  const [clusterError, setClusterError] = useState("");
  const [clusterLoading, setClusterLoading] = useState(false);
  const [inventory, setInventory] = useState<SnapshotVmInventoryResponse | undefined>();
  const [inventoryFilters, setInventoryFilters] = useState<SnapshotVmInventoryFilters>({ page: 1, pageSize: 100 });
  const [inventoryError, setInventoryError] = useState("");
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryColumnOrder, setInventoryColumnOrder] = useState<InventoryColumnKey[]>(defaultInventoryColumnOrder);
  const [draggedInventoryColumn, setDraggedInventoryColumn] = useState<InventoryColumnKey | undefined>();
  const [relationships, setRelationships] = useState<RelationshipResponse | undefined>();
  const [relationshipsError, setRelationshipsError] = useState("");
  const [relationshipsLoading, setRelationshipsLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [settingsError, setSettingsError] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [selectedSavedViewId, setSelectedSavedViewId] = useState("");
  const [savedViewName, setSavedViewName] = useState("");
  const [savedViewError, setSavedViewError] = useState("");
  const [savedViewMessage, setSavedViewMessage] = useState("");
  const [savingView, setSavingView] = useState(false);

  useEffect(() => {
    const handleHashChange = () => {
      setActivePage(pageFromHash());
      setRouteHash(window.location.hash);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    if (!session.authenticated) {
      setManagers([]);
      setSnapshots([]);
      setSelectedSnapshot(undefined);
      setDashboard(undefined);
      setClusterDetail(undefined);
      setInventory(undefined);
      setRelationships(undefined);
      setSettings(undefined);
      setSavedViews([]);
      setSelectedSavedViewId("");
      setSavedViewName("");
      return;
    }

    listManagers()
      .then(setManagers)
      .catch((error: unknown) => {
        setManagerError(error instanceof Error ? error.message : "Manager list failed");
      });
    listSnapshots()
      .then(setSnapshots)
      .catch((error: unknown) => {
        setSnapshotError(error instanceof Error ? error.message : "Snapshot list failed");
      });
    getDashboard()
      .then(setDashboard)
      .catch((error: unknown) => {
        setDashboardError(error instanceof Error ? error.message : "Dashboard failed");
      });
    void loadInventory(inventoryFilters);
    void loadSettings();
    void loadSavedViews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.authenticated]);

  useEffect(() => {
    if (session.authenticated && activePage === "inventory") {
      void loadInventory(inventoryFilters);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage, session.authenticated]);

  useEffect(() => {
    if (session.authenticated && activePage === "settings") {
      void loadSettings();
    }
  }, [activePage, session.authenticated]);

  useEffect(() => {
    if (session.authenticated && activePage === "relationships") {
      void loadRelationships();
    }
  }, [activePage, session.authenticated]);

  useEffect(() => {
    if (!session.authenticated || activePage !== "cluster") {
      setClusterDetail(undefined);
      setClusterError("");
      setClusterLoading(false);
      return;
    }

    const params = clusterParamsFromHash(routeHash);
    if (!params) {
      setClusterDetail(undefined);
      setClusterError("Cluster not found");
      setClusterLoading(false);
      return;
    }

    let active = true;
    setClusterLoading(true);
    setClusterError("");
    getDashboardCluster(params.managerId, params.clusterId)
      .then((cluster) => {
        if (active) {
          setClusterDetail(cluster);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setClusterDetail(undefined);
          setClusterError(error instanceof Error ? error.message : "Cluster detail failed");
        }
      })
      .finally(() => {
        if (active) {
          setClusterLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [activePage, routeHash, session.authenticated]);

  useEffect(() => {
    let active = true;
    getSession()
      .then((data) => {
        if (active) {
          setSession(data);
        }
      })
      .finally(() => {
        if (active) {
          setAuthStatus("ready");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoginPending(true);
    setLoginError("");

    try {
      const nextSession = await login(String(form.get("username") ?? ""), String(form.get("password") ?? ""));
      setSession(nextSession);
      event.currentTarget.reset();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed");
    } finally {
      setLoginPending(false);
    }
  }

  async function handleLogout() {
    setSession(await logout());
    setEditingManager(undefined);
    setManagers([]);
    setSnapshots([]);
    setSelectedSnapshot(undefined);
    setDashboard(undefined);
    setClusterDetail(undefined);
    setInventory(undefined);
    setRelationships(undefined);
    setSettings(undefined);
    setSavedViews([]);
    setSelectedSavedViewId("");
    setSavedViewName("");
  }

  async function loadInventory(filters: SnapshotVmInventoryFilters) {
    setInventoryLoading(true);
    setInventoryError("");
    try {
      setInventory(await getSnapshotVmInventory(filters));
    } catch (error) {
      setInventoryError(error instanceof Error ? error.message : "Inventory failed");
    } finally {
      setInventoryLoading(false);
    }
  }

  async function loadRelationships() {
    setRelationshipsLoading(true);
    setRelationshipsError("");
    try {
      setRelationships(await getRelationships());
    } catch (error) {
      setRelationshipsError(error instanceof Error ? error.message : "Relationships failed");
    } finally {
      setRelationshipsLoading(false);
    }
  }

  async function loadSettings() {
    setSettingsLoading(true);
    setSettingsError("");
    try {
      setSettings(await getSettings());
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Settings failed");
    } finally {
      setSettingsLoading(false);
    }
  }

  async function handleSettingsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSettingsSaving(true);
    setSettingsError("");
    setSettingsMessage("");
    try {
      const saved = await updateSettings({
        snapshotIntervalMinutes: Number(form.get("snapshotIntervalMinutes")),
        snapshotRetentionDays: Number(form.get("snapshotRetentionDays"))
      });
      setSettings(saved);
      setSettingsMessage("Settings saved");
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Settings save failed");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function loadSavedViews() {
    setSavedViewError("");
    try {
      setSavedViews(await listSavedViews(inventorySavedViewScope));
    } catch (error) {
      setSavedViewError(error instanceof Error ? error.message : "Saved views failed");
    }
  }

  async function handleInventoryFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextFilters = {
      search: String(form.get("search") ?? ""),
      managerId: String(form.get("managerId") ?? ""),
      clusterId: String(form.get("clusterId") ?? ""),
      powerState: String(form.get("powerState") ?? ""),
      sortBy: inventoryFilters.sortBy,
      sortDirection: inventoryFilters.sortDirection,
      page: 1,
      pageSize: inventoryFilters.pageSize ?? 100
    };
    setInventoryFilters(nextFilters);
    await loadInventory(nextFilters);
  }

  async function clearInventoryFilters() {
    const nextFilters = { sortBy: inventoryFilters.sortBy, sortDirection: inventoryFilters.sortDirection, page: 1, pageSize: inventoryFilters.pageSize ?? 100 };
    setInventoryFilters(nextFilters);
    await loadInventory(nextFilters);
  }

  async function handleInventorySort(sortBy: SnapshotVmInventorySortKey) {
    const sortDirection: SnapshotVmInventorySortDirection =
      inventoryFilters.sortBy === sortBy && inventoryFilters.sortDirection !== "desc" ? "desc" : "asc";
    const nextFilters = { ...inventoryFilters, sortBy, sortDirection, page: 1 };
    setInventoryFilters(nextFilters);
    await loadInventory(nextFilters);
  }

  function handleInventoryColumnDrop(targetKey: InventoryColumnKey) {
    if (!draggedInventoryColumn || draggedInventoryColumn === targetKey) {
      setDraggedInventoryColumn(undefined);
      return;
    }
    setInventoryColumnOrder((current) => reorderInventoryColumns(current, draggedInventoryColumn, targetKey));
    setDraggedInventoryColumn(undefined);
  }

  async function handleSavedViewSelect(event: ChangeEvent<HTMLSelectElement>) {
    const viewId = event.currentTarget.value;
    setSelectedSavedViewId(viewId);
    setSavedViewMessage("");
    setSavedViewError("");
    if (!viewId) {
      setSavedViewName("");
      return;
    }

    const view = savedViews.find((item) => item.id === viewId);
    if (!view) {
      return;
    }
    const nextFilters = savedViewFilters(view);
    setSavedViewName(view.name);
    setInventoryColumnOrder(savedViewColumns(view));
    setInventoryFilters(nextFilters);
    await loadInventory(nextFilters);
  }

  async function handleSaveInventoryView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("savedViewName") ?? "").trim();
    if (!name) {
      setSavedViewError("View name is required");
      return;
    }

    setSavingView(true);
    setSavedViewError("");
    setSavedViewMessage("");
    try {
      const input = {
        name,
        scope: inventorySavedViewScope,
        filters: compactInventoryFilters(inventoryFilters),
        columns: inventoryColumnOrder,
        sort: {
          sortBy: inventoryFilters.sortBy,
          sortDirection: inventoryFilters.sortDirection
        }
      };
      const saved = selectedSavedViewId ? await updateSavedView(selectedSavedViewId, input) : await createSavedView(input);
      setSavedViews((current) => [saved, ...current.filter((view) => view.id !== saved.id)]);
      setSelectedSavedViewId(saved.id);
      setSavedViewName(saved.name);
      setSavedViewMessage("Inventory view saved");
    } catch (error) {
      setSavedViewError(error instanceof Error ? error.message : "Save view failed");
    } finally {
      setSavingView(false);
    }
  }

  async function handleManagerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : undefined;
    const action = submitter instanceof HTMLButtonElement ? submitter.value : "save";
    const { input, username, password } = managerInputFromForm(formElement);
    if (action === "test") {
      await handleManagerTestCollection(input);
      return;
    }

    setManagerError("");
    setManagerMessage("");
    setTestCollectionResult(undefined);
    try {
      const saved = editingManager
        ? await updateManager(editingManager.id, input)
        : await createManager({ ...input, username, password });
      setManagers((current) => {
        const others = current.filter((manager) => manager.id !== saved.id);
        return [...others, saved].sort((left, right) => left.name.localeCompare(right.name));
      });
      setDashboard(await getDashboard());
      setManagerMessage(editingManager ? "Manager updated" : "Manager added");
      setEditingManager(undefined);
      formElement.reset();
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : "Manager save failed");
    }
  }

  async function handleManagerTestCollection(input: ManagerInput) {
    setManagerError("");
    setManagerMessage("");
    setTestCollectionResult(undefined);
    setTestCollectionPending(true);

    try {
      const result = await testManagerCollection({
        managerId: editingManager?.id,
        ...input
      });
      setTestCollectionResult(result);
      setManagerMessage(`Test collection ${result.status}; no snapshot saved`);
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : "Test collection failed");
    } finally {
      setTestCollectionPending(false);
    }
  }

  async function handleManagerDelete(id: string) {
    setManagerError("");
    setManagerMessage("");
    try {
      await deleteManager(id);
      setManagers((current) => current.filter((manager) => manager.id !== id));
      if (editingManager?.id === id) {
        setEditingManager(undefined);
      }
      setDashboard(await getDashboard());
      setManagerMessage("Manager removed");
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : "Manager delete failed");
    }
  }

  async function handleCollect(manager: Manager) {
    setManagerError("");
    setManagerMessage("");
    setCollectedSnapshot(undefined);
    setCollectionBusyId(manager.id);

    try {
      const saved = await collectManager(manager.id);
      setCollectedSnapshot(saved);
      setSelectedSnapshot(saved);
      setSnapshots((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setDashboard(await getDashboard());
      await loadInventory(inventoryFilters);
      setManagerMessage(`Collection ${saved.status}; snapshot saved`);
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : "Collection failed");
    } finally {
      setCollectionBusyId(undefined);
    }
  }

  async function handleCollectAll() {
    setManagerError("");
    const enabledManagerCount = managers.filter((manager) => manager.enabled).length;
    setManagerMessage(`Collecting ${enabledManagerCount} enabled manager(s)`);
    setCollectedSnapshot(undefined);
    setCollectionBusyId("all");

    try {
      const savedSnapshots = await collectAllManagers();
      const savedIds = new Set(savedSnapshots.map((snapshot) => snapshot.id));
      setSnapshots((current) => [...savedSnapshots, ...current.filter((item) => !savedIds.has(item.id))]);
      if (savedSnapshots[0]) {
        const selected = await getSnapshot(savedSnapshots[0].id);
        setSelectedSnapshot(selected);
        setCollectedSnapshot(selected);
      }
      setDashboard(await getDashboard());
      await loadInventory(inventoryFilters);
      setManagerMessage(savedSnapshots.length > 0 ? `Collected ${savedSnapshots.length} enabled manager(s)` : "No enabled managers collected");
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : "Collection failed");
    } finally {
      setCollectionBusyId(undefined);
    }
  }

  async function handleSnapshotSelect(id: string) {
    setSnapshotError("");
    try {
      setSelectedSnapshot(await getSnapshot(id));
    } catch (error) {
      setSnapshotError(error instanceof Error ? error.message : "Snapshot detail failed");
    }
  }

  function handleSnapshotFilterChange(event: ChangeEvent<HTMLSelectElement>) {
    const { name, value } = event.currentTarget;
    setSnapshotFilters((current) => ({ ...current, [name]: value }));
  }

  const latestSnapshot = snapshots[0];
  const dashboardCards = dashboard
    ? [
        { label: "Managers", value: dashboard.totals.managers, icon: Server },
        { label: "Clusters", value: dashboard.totals.clusters, icon: Database },
        { label: "Hosts", value: dashboard.totals.hosts, icon: HardDrive },
        { label: "VMs", value: dashboard.totals.vms, icon: Activity },
        { label: "Storage", value: dashboard.totals.storageDomains, icon: Database },
        { label: "Disks", value: dashboard.totals.disks, icon: HardDrive },
        { label: "Networks", value: dashboard.totals.networks, icon: Network }
      ]
    : [];
  const activeInventoryFilterCount = countActiveInventoryFilters(inventoryFilters);
  const inventoryLatestCollectedAt = latestInventoryCollectedAt(inventory?.rows);
  const filteredSnapshots = snapshots.filter((snapshot) => matchesSnapshotFilters(snapshot, snapshotFilters));
  const snapshotManagerOptions = uniqueSnapshotManagers(snapshots);
  const snapshotStatusOptions = uniqueSnapshotStatuses(snapshots);

  return (
    <div className={`app-shell ${sidebarCollapsed ? "nav-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="Primary navigation" aria-hidden={sidebarCollapsed || undefined} inert={sidebarCollapsed || undefined}>
        <div className="sidebar-brand">
          <div className="brand-mark">
            <Database aria-hidden="true" size={17} />
          </div>
          <div>
            <strong>ovirt-inventory</strong>
            <span>Manager snapshots</span>
          </div>
          <button className="sidebar-toggle" type="button" onClick={() => setSidebarCollapsed(true)} title="Hide navigation" aria-label="Hide navigation">
            <Menu aria-hidden="true" size={18} />
          </button>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-nav-group">
            <a href="#dashboard" aria-current={activePage === "dashboard" ? "page" : undefined}>
              <LayoutDashboard aria-hidden="true" size={17} />
              Overview
            </a>
            <a href="#inventory" aria-current={activePage === "inventory" ? "page" : undefined}>
              <PackageSearch aria-hidden="true" size={17} />
              Inventory
            </a>
            <a href="#capacity" aria-current={activePage === "capacity" ? "page" : undefined}>
              <ChartLine aria-hidden="true" size={17} />
              Capacity
              <span className="nav-testing-badge">Testing</span>
            </a>
            <a href="#relationships" aria-current={activePage === "relationships" ? "page" : undefined}>
              <Waypoints aria-hidden="true" size={17} />
              Topology
            </a>
            <a href="#managers" aria-current={activePage === "managers" ? "page" : undefined}>
              <Server aria-hidden="true" size={17} />
              Managers
            </a>
          </div>
          <div className="sidebar-nav-group sidebar-nav-bottom">
            <span className="sidebar-version">ovirt-inventory v{appPackage.version}</span>
            <a href="#history" aria-current={activePage === "history" ? "page" : undefined}>
              <History aria-hidden="true" size={17} />
              History
            </a>
            <a href="#settings" aria-current={activePage === "settings" ? "page" : undefined}>
              <Settings aria-hidden="true" size={17} />
              Settings
            </a>
          </div>
        </nav>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-title">
            {sidebarCollapsed && (
              <button className="icon-button nav-open-button" type="button" onClick={() => setSidebarCollapsed(false)} title="Show navigation" aria-label="Show navigation">
                <PanelLeftOpen aria-hidden="true" size={18} />
              </button>
            )}
            <div>
            <p className="eyebrow">oVirt manager inventory</p>
            <h1 id="page-title">{session.authenticated ? pageTitles[activePage] : "Login"}</h1>
            </div>
          </div>
          <div className="topbar-actions">
            {session.authenticated ? (
              <button className="icon-button" type="button" onClick={handleLogout} title="Logout" aria-label="Logout">
                <LogOut aria-hidden="true" size={17} />
              </button>
            ) : (
              <span className="state-pill">Login required</span>
            )}
          </div>
        </header>

        <main className={`content-shell ${activePage === "inventory" || activePage === "capacity" || activePage === "relationships" ? "inventory-content-shell" : ""}`} aria-labelledby="page-title">
          {authStatus === "checking" && <p className="muted">Checking session</p>}

          {authStatus === "ready" && !session.authenticated && (
            <section className="login-panel" aria-label="Login">
              <form className="login-form" onSubmit={handleLogin}>
                <label>
                  Username
                  <input name="username" autoComplete="username" required />
                </label>
                <label>
                  Password
                  <input name="password" type="password" autoComplete="current-password" required />
                </label>
                <button className="button" type="submit" disabled={loginPending} aria-busy={loginPending}>
                  <LogIn aria-hidden="true" size={17} />
                  {loginPending ? "Signing in" : "Login"}
                </button>
                {loginError && (
                  <p className="form-error" role="alert">
                    {loginError}
                  </p>
                )}
              </form>
            </section>
          )}

          {session.authenticated && activePage === "dashboard" && (
            <section className="dashboard-panel" aria-labelledby="dashboard">
              <div className="section-heading with-actions">
                <div>
                  <LayoutDashboard aria-hidden="true" size={20} />
                  <div>
                    <h2 id="dashboard">Overview</h2>
                    <p>
                      {latestSnapshot
                        ? `Latest snapshot: ${latestSnapshot.managerName} at ${new Date(latestSnapshot.collectedAt).toLocaleString()}`
                        : "No inventory snapshots saved yet"}
                    </p>
                  </div>
                </div>
                <span className="state-pill">{snapshots.length} snapshots</span>
              </div>
              {dashboardError && (
                <p className="form-error" role="alert">
                  {dashboardError}
                </p>
              )}
              {dashboard && (
                <>
                  <section className="inventory-grid kpi-grid" aria-label="Inventory totals">
                    {dashboardCards.map(({ label, value, icon: Icon }) => (
                      <article className="metric compact" key={label}>
                        <span className="metric-icon">
                          <Icon aria-hidden="true" size={18} />
                        </span>
                        <div>
                          <span className="metric-label">{label}</span>
                          <strong>{value}</strong>
                        </div>
                      </article>
                    ))}
                  </section>
                  <ClusterTable clusters={dashboard.clusters} managers={dashboard.managers} />
                </>
              )}
            </section>
          )}

          {session.authenticated && activePage === "cluster" && (
            <section className="cluster-detail-panel" aria-labelledby="cluster-detail">
              <div className="section-heading with-actions">
                <div>
                  <Server aria-hidden="true" size={20} />
                  <div>
                    <h2 id="cluster-detail">{clusterDetail?.name ?? "Cluster Detail"}</h2>
                    <p>
                      {clusterDetail
                        ? `${clusterDetail.managerName} at ${new Date(clusterDetail.collectedAt).toLocaleString()}`
                        : "Loading cluster inventory"}
                    </p>
                  </div>
                </div>
                <a className="button secondary" href="#dashboard">
                  <ArrowLeft aria-hidden="true" size={16} />
                  Overview
                </a>
              </div>
              {clusterError && (
                <p className="form-error" role="alert">
                  {clusterError}
                </p>
              )}
              {clusterLoading && <p className="muted">Loading cluster inventory</p>}
              {clusterDetail && (
                <>
                  <section className="inventory-grid compact-grid" aria-label="Cluster totals">
                    <article className="metric compact">
                      <span className="metric-icon">
                        <HardDrive aria-hidden="true" size={18} />
                      </span>
                      <div>
                        <span className="metric-label">Nodes</span>
                        <strong>{clusterDetail.hostCount}</strong>
                      </div>
                    </article>
                    <article className="metric compact">
                      <span className="metric-icon">
                        <Activity aria-hidden="true" size={18} />
                      </span>
                      <div>
                        <span className="metric-label">VMs</span>
                        <strong>{clusterDetail.vmCount}</strong>
                      </div>
                    </article>
                    <article className="metric compact">
                      <span className="metric-icon">
                        <Database aria-hidden="true" size={18} />
                      </span>
                      <div>
                        <span className="metric-label">Storage Domains</span>
                        <strong>{clusterDetail.storageDomainCount}</strong>
                      </div>
                    </article>
                  </section>
                  <ClusterVmTable vms={clusterDetail.vms} />
                </>
              )}
            </section>
          )}

          {session.authenticated && activePage === "inventory" && (
            <section className="inventory-panel" aria-labelledby="inventory-title">
              <div className="section-heading with-actions">
                <div>
                  <PackageSearch aria-hidden="true" size={20} />
                  <div>
                    <h2 id="inventory-title">Inventory</h2>
                    <p>{inventory ? `${inventory.total} VM records from latest snapshots` : "Latest snapshot VM inventory"}</p>
                  </div>
                </div>
                <div className="topbar-actions">
                  <button className="button secondary" type="button" disabled={inventoryLoading} aria-busy={inventoryLoading} onClick={() => void loadInventory(inventoryFilters)}>
                    <RefreshCw aria-hidden="true" size={16} />
                    {inventoryLoading ? "Refreshing" : "Refresh"}
                  </button>
                  <a className="button secondary" href={snapshotVmInventoryExportUrl("csv", inventoryFilters)}>
                    <Download aria-hidden="true" size={16} />
                    Export CSV
                  </a>
                  <a className="button secondary" href={snapshotVmInventoryExportUrl("pdf", inventoryFilters)}>
                    <Download aria-hidden="true" size={16} />
                    Export PDF
                  </a>
                </div>
              </div>
              <form className="saved-view-bar" onSubmit={(event) => void handleSaveInventoryView(event)}>
                <label>
                  <span>Saved View</span>
                  <select value={selectedSavedViewId} onChange={(event) => void handleSavedViewSelect(event)}>
                    <option value="">Current layout</option>
                    {savedViews.map((view) => (
                      <option key={view.id} value={view.id}>
                        {view.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>View Name</span>
                  <input
                    name="savedViewName"
                    value={savedViewName}
                    onChange={(event) => setSavedViewName(event.currentTarget.value)}
                    placeholder="Operations review"
                  />
                </label>
                <button className="button secondary" type="submit" disabled={savingView} aria-busy={savingView}>
                  <Save aria-hidden="true" size={16} />
                  {savingView ? "Saving View" : selectedSavedViewId ? "Update View" : "Save View"}
                </button>
              </form>
              {savedViewError && (
                <p className="form-error" role="alert">
                  {savedViewError}
                </p>
              )}
              {savedViewMessage && <p className="form-success">{savedViewMessage}</p>}
              <div className="inventory-summary-row" aria-label="Inventory result summary">
                <span className="state-pill">{inventory ? `${inventory.total} VMs` : "Loading VMs"}</span>
                <span className="state-pill">{activeInventoryFilterCount} active filters</span>
                <span className="state-pill">
                  {inventoryLatestCollectedAt ? `Latest: ${new Date(inventoryLatestCollectedAt).toLocaleString()}` : "No collection timestamp"}
                </span>
              </div>
              <form className="inventory-filter-form" key={inventoryFilterKey(inventoryFilters)} onSubmit={(event) => void handleInventoryFilter(event)}>
                <label>
                  <span>Search</span>
                  <input name="search" defaultValue={inventoryFilters.search ?? ""} placeholder="VM, host, OS, IP" />
                </label>
                <label>
                  <span>Manager</span>
                  <select name="managerId" defaultValue={inventoryFilters.managerId ?? ""}>
                    <option value="">All</option>
                    {inventory?.filterOptions.managers.map((manager) => (
                      <option key={manager.value} value={manager.value}>
                        {manager.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Cluster</span>
                  <select name="clusterId" defaultValue={inventoryFilters.clusterId ?? ""}>
                    <option value="">All</option>
                    {inventory?.filterOptions.clusters.map((cluster) => (
                      <option key={cluster.value} value={cluster.value}>
                        {cluster.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Power State</span>
                  <select name="powerState" defaultValue={inventoryFilters.powerState ?? ""}>
                    <option value="">All</option>
                    {inventory?.filterOptions.powerStates.map((state) => (
                      <option key={state} value={state}>
                        {state}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="manager-actions">
                  <button className="button" type="submit" disabled={inventoryLoading} aria-busy={inventoryLoading}>
                    {inventoryLoading ? "Filtering" : "Filter"}
                  </button>
                  <button className="button secondary" type="button" onClick={() => void clearInventoryFilters()}>
                    Clear
                  </button>
                </div>
              </form>
              {inventoryError && (
                <p className="form-error" role="alert">
                  {inventoryError}
                </p>
              )}
              {inventoryLoading && <p className="muted">Loading inventory</p>}
              {inventory && (
                <InventoryTable
                  columnOrder={inventoryColumnOrder}
                  draggedColumn={draggedInventoryColumn}
                  inventory={inventory}
                  onColumnDragStart={setDraggedInventoryColumn}
                  onColumnDrop={handleInventoryColumnDrop}
                  onSort={(sortBy) => void handleInventorySort(sortBy)}
                  sortBy={inventoryFilters.sortBy}
                  sortDirection={inventoryFilters.sortDirection}
                />
              )}
            </section>
          )}

          {session.authenticated && activePage === "capacity" && <CapacityPage />}

          {session.authenticated && activePage === "relationships" && (
            <RelationshipReportBuilder
              error={relationshipsError}
              loading={relationshipsLoading}
              relationships={relationships}
              onRefresh={() => void loadRelationships()}
            />
          )}

          {session.authenticated && activePage === "settings" && (
            <section className="settings-panel" aria-labelledby="settings-title">
              <div className="section-heading with-actions">
                <div>
                  <Settings aria-hidden="true" size={20} />
                  <div>
                    <h2 id="settings-title">Settings</h2>
                    <p>Configure snapshot collection and history retention.</p>
                  </div>
                </div>
                <button className="button secondary" type="button" disabled={settingsLoading} aria-busy={settingsLoading} onClick={() => void loadSettings()}>
                  <RefreshCw aria-hidden="true" size={16} />
                  {settingsLoading ? "Refreshing" : "Refresh"}
                </button>
              </div>
              {settingsError && (
                <p className="form-error" role="alert">
                  {settingsError}
                </p>
              )}
              {settingsMessage && <p className="form-success">{settingsMessage}</p>}
              {settingsLoading && <p className="muted">Loading settings</p>}
              {settings && (
                <form className="settings-form" key={`${settings.snapshotIntervalMinutes}:${settings.snapshotRetentionDays}`} onSubmit={(event) => void handleSettingsSubmit(event)}>
                  <div className="form-card-header">
                    <div>
                      <h3>Snapshot Policy</h3>
                      <p>These settings apply to backend snapshot collection and stored snapshot history.</p>
                    </div>
                  </div>
                  <div className="settings-fields">
                    <label>
                      <span>Snapshot interval</span>
                      <input
                        name="snapshotIntervalMinutes"
                        type="number"
                        min="1"
                        max="1440"
                        step="1"
                        defaultValue={settings.snapshotIntervalMinutes}
                        required
                      />
                    </label>
                    <label>
                      <span>Snapshot data retention</span>
                      <input
                        name="snapshotRetentionDays"
                        type="number"
                        min="0"
                        max="3650"
                        step="1"
                        defaultValue={settings.snapshotRetentionDays}
                        required
                      />
                    </label>
                  </div>
                  <div className="settings-summary-row" aria-label="Settings summary">
                    <span className="state-pill">Interval: every {settings.snapshotIntervalMinutes} minutes</span>
                    <span className="state-pill">
                      Retention: {settings.snapshotRetentionDays === 0 ? "keep indefinitely" : `${settings.snapshotRetentionDays} days`}
                    </span>
                    <span className="state-pill">{settings.updatedAt ? `Updated: ${new Date(settings.updatedAt).toLocaleString()}` : "Using defaults"}</span>
                  </div>
                  <div className="manager-actions form-actions">
                    <button className="button" type="submit" disabled={settingsSaving} aria-busy={settingsSaving}>
                      <Save aria-hidden="true" size={16} />
                      {settingsSaving ? "Saving" : "Save Settings"}
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}

          {session.authenticated && activePage === "managers" && (
            <section className="manager-panel" aria-labelledby="managers">
              <div className="section-heading with-actions">
                <div>
                  <Server aria-hidden="true" size={20} />
                  <div>
                    <h2 id="managers">Managers</h2>
                    <p>Save encrypted oVirt credentials and manually trigger backend collection.</p>
                  </div>
                </div>
                <button className="button" type="button" disabled={Boolean(collectionBusyId)} aria-busy={collectionBusyId === "all"} onClick={() => void handleCollectAll()}>
                  <Play aria-hidden="true" size={16} />
                  {collectionBusyId === "all" ? "Collecting" : "Collect All"}
                </button>
              </div>
              <form className="manager-form" key={editingManager?.id ?? "new-manager"} onSubmit={handleManagerSubmit}>
                <div className="form-card-header">
                  <div>
                    <h3>{editingManager ? "Edit Manager" : "Add Manager"}</h3>
                    <p>{editingManager ? "Update connection details or test saved credentials." : "Register an oVirt Manager connection before collecting inventory."}</p>
                  </div>
                  {editingManager && <span className="state-pill">Editing {editingManager.name}</span>}
                </div>
                <div className="manager-fields">
                  <label>
                    <span>Name</span>
                    <input name="name" defaultValue={editingManager?.name ?? ""} required />
                  </label>
                  <label>
                    <span>URL</span>
                    <input name="url" defaultValue={editingManager?.url ?? ""} placeholder="https://manager/ovirt-engine" required />
                  </label>
                  <label>
                    <span>Username</span>
                    <input name="username" autoComplete="off" required={!editingManager} />
                  </label>
                  <label>
                    <span>Password</span>
                    <input name="password" type="password" autoComplete="off" required={!editingManager} />
                  </label>
                </div>
                <div className="manager-option-row">
                  <label className="toggle-row">
                    <input name="enabled" type="checkbox" defaultChecked={editingManager?.enabled ?? true} />
                    Enabled
                  </label>
                  <label className="toggle-row tls-toggle">
                    <input name="ignoreTls" type="checkbox" defaultChecked={editingManager?.ignoreTls ?? false} />
                    Ignore TLS
                  </label>
                </div>
                <div className="manager-actions form-actions">
                  <button className="button secondary" type="submit" name="managerAction" value="test" disabled={testCollectionPending} aria-busy={testCollectionPending}>
                    <Play aria-hidden="true" size={16} />
                    {testCollectionPending ? "Testing" : "Test Collection"}
                  </button>
                  <button className="button" type="submit" name="managerAction" value="save" disabled={testCollectionPending}>
                    {editingManager ? "Save" : "Add"}
                  </button>
                  {editingManager && (
                    <button className="button secondary" type="button" disabled={testCollectionPending} onClick={() => setEditingManager(undefined)}>
                      Cancel
                    </button>
                  )}
                </div>
              </form>
              {managerError && (
                <p className="form-error" role="alert">
                  {managerError}
                </p>
              )}
              {managerMessage && <p className="form-success">{managerMessage}</p>}
              {testCollectionResult && (
                <div className={`collection-panel status-panel ${statusClass(testCollectionResult.status)}`} aria-live="polite">
                  <div className="section-heading compact-heading">
                    <Clock aria-hidden="true" size={18} />
                    <h3>Test Collection</h3>
                  </div>
                  <dl className="snapshot-summary">
                    <div>
                      <dt>Status</dt>
                      <dd>{testCollectionResult.status}</dd>
                    </div>
                    <div>
                      <dt>Collected</dt>
                      <dd>{new Date(testCollectionResult.collectedAt).toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Resources</dt>
                      <dd>{formatResourceCounts(testCollectionResult.resourceCounts)}</dd>
                    </div>
                    <div>
                      <dt>Issues</dt>
                      <dd>
                        {testCollectionResult.warningsCount} warnings, {testCollectionResult.errorsCount} errors
                      </dd>
                    </div>
                  </dl>
                </div>
              )}
              <div className="manager-list" aria-label="Saved managers">
                {managers.length === 0 && <p className="empty-state">No managers saved yet</p>}
                {managers.map((manager) => (
                  <article className="manager-row" key={manager.id}>
                    <div>
                      <strong>{manager.name}</strong>
                      <span>{manager.url}</span>
                    </div>
                    <span className={`state-pill ${manager.enabled ? "status-success" : "status-muted"}`}>{manager.enabled ? "Enabled" : "Disabled"}</span>
                    {manager.ignoreTls && <span className="state-pill status-warning">Ignore TLS</span>}
                    <span className="state-pill">{manager.credentialStatus}</span>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={Boolean(collectionBusyId) || !manager.enabled}
                      aria-busy={collectionBusyId === manager.id}
                      onClick={() => void handleCollect(manager)}
                    >
                      <Play aria-hidden="true" size={16} />
                      {collectionBusyId === manager.id ? "Collecting" : "Collect"}
                    </button>
                    <button className="button secondary" type="button" onClick={() => setEditingManager(manager)}>
                      Edit
                    </button>
                    <button className="button danger" type="button" onClick={() => void handleManagerDelete(manager.id)}>
                      Remove
                    </button>
                  </article>
                ))}
              </div>
              {(collectionBusyId || collectedSnapshot) && (
                <div className="collection-panel" aria-live="polite">
                  <div className="section-heading compact-heading">
                    <Clock aria-hidden="true" size={18} />
                    <h3>Collection</h3>
                  </div>
                  {collectionBusyId && <span className="state-pill">backend: running</span>}
                  {collectedSnapshot && (
                    <dl className="snapshot-summary">
                      <div>
                        <dt>Status</dt>
                        <dd>{collectedSnapshot.status}</dd>
                      </div>
                      <div>
                        <dt>Collected</dt>
                        <dd>{new Date(collectedSnapshot.collectedAt).toLocaleString()}</dd>
                      </div>
                      <div>
                        <dt>Resources</dt>
                        <dd>{formatResourceCounts(collectedSnapshot.resourceCounts)}</dd>
                      </div>
                      <div>
                        <dt>Errors</dt>
                        <dd>{collectedSnapshot.errors.length}</dd>
                      </div>
                    </dl>
                  )}
                </div>
              )}
            </section>
          )}

          {session.authenticated && activePage === "history" && (
            <section className="snapshot-panel-page" aria-labelledby="history">
              <div className="section-heading">
                <History aria-hidden="true" size={20} />
                <div>
                  <h2 id="history">Snapshot History</h2>
                  <p>Review saved inventory points and export the selected snapshot to Excel.</p>
                </div>
              </div>
              {snapshotError && (
                <p className="form-error" role="alert">
                  {snapshotError}
                </p>
              )}
              <form className="history-filter-form" aria-label="Snapshot filters">
                <label>
                  <span>Manager</span>
                  <select name="managerId" value={snapshotFilters.managerId} onChange={handleSnapshotFilterChange}>
                    <option value="">All</option>
                    {snapshotManagerOptions.map((manager) => (
                      <option key={manager.value} value={manager.value}>
                        {manager.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Status</span>
                  <select name="status" value={snapshotFilters.status} onChange={handleSnapshotFilterChange}>
                    <option value="">All</option>
                    {snapshotStatusOptions.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </label>
              </form>
              <div className="snapshot-history">
                <div className="snapshot-list">
                  {filteredSnapshots.length === 0 && <p className="empty-state">No snapshots match the current filters</p>}
                  {filteredSnapshots.map((snapshot) => (
                    <button className="snapshot-button" key={snapshot.id} type="button" onClick={() => void handleSnapshotSelect(snapshot.id)}>
                      <span className={`snapshot-icon ${statusClass(snapshot.status)}`}>
                        <SnapshotStatusIcon status={snapshot.status} />
                      </span>
                      <span>
                        <strong>{snapshot.managerName}</strong>
                        <small>
                          {snapshot.status} at {new Date(snapshot.collectedAt).toLocaleString()}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
                {selectedSnapshot ? (
                  <div className="snapshot-detail">
                    <div className="snapshot-detail-header">
                      <div>
                        <h3>{selectedSnapshot.managerName}</h3>
                        <p className="muted">{selectedSnapshot.managerUrl}</p>
                      </div>
                      <a className="button export-link" href={`/api/exports/excel?snapshotId=${encodeURIComponent(selectedSnapshot.id)}`}>
                        <Download aria-hidden="true" size={16} />
                        Export Excel
                      </a>
                    </div>
                    <dl className="snapshot-summary">
                      <div>
                        <dt>Status</dt>
                        <dd>{selectedSnapshot.status}</dd>
                      </div>
                      <div>
                        <dt>Collected</dt>
                        <dd>{new Date(selectedSnapshot.collectedAt).toLocaleString()}</dd>
                      </div>
                      <div>
                        <dt>Resources</dt>
                        <dd>{formatResourceCounts(selectedSnapshot.resourceCounts)}</dd>
                      </div>
                      <div>
                        <dt>Issues</dt>
                        <dd>
                          {selectedSnapshot.warningsCount} warnings, {selectedSnapshot.errorsCount} errors
                        </dd>
                      </div>
                    </dl>
                  </div>
                ) : (
                  <div className="snapshot-detail empty-detail">
                    <History aria-hidden="true" size={22} />
                    <h3>Select a snapshot to view details.</h3>
                    <p className="muted">Snapshot details, issue counts, and Excel export appear here after selection.</p>
                  </div>
                )}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function ClusterTable({
  clusters,
  managers
}: {
  clusters: DashboardClusterSummary[];
  managers: DashboardResponse["managers"];
}) {
  const managersById = new Map(managers.map((manager) => [manager.id, manager]));
  return (
    <section className="table-card" aria-labelledby="cluster-table-title">
      <div className="table-title">
        <h3 id="cluster-table-title">Clusters</h3>
      </div>
      {clusters.length === 0 ? (
        <p className="empty-state">No clusters collected yet</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table adaptive-data-table">
            <thead>
              <tr>
                <th scope="col">Cluster</th>
                <th scope="col">Manager</th>
                <th scope="col">Data Center</th>
                <th scope="col">Nodes</th>
                <th scope="col">VMs</th>
                <th scope="col">Storage Domains</th>
                <th scope="col">Version</th>
                <th scope="col">Freshness</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {clusters.map((cluster) => {
                const manager = managersById.get(cluster.managerId);
                return (
                  <tr key={`${cluster.managerId}:${cluster.clusterId}`}>
                    <td>
                      <a className="table-link" href={clusterHash(cluster.managerId, cluster.clusterId)}>
                        {cluster.name}
                      </a>
                    </td>
                    <td>{cluster.managerName}</td>
                    <td>{cluster.dataCenterName ?? cluster.dataCenterId ?? "-"}</td>
                    <td>{cluster.hostCount}</td>
                    <td>{cluster.vmCount}</td>
                    <td>{cluster.storageDomainCount}</td>
                    <td>{cluster.version ?? "-"}</td>
                    <td>{manager?.freshness ? new Date(manager.freshness).toLocaleString() : new Date(cluster.collectedAt).toLocaleString()}</td>
                    <td>
                      <StatusPill status={manager?.lastStatus ?? "success"} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function InventoryTable({
  columnOrder,
  draggedColumn,
  inventory,
  onColumnDragStart,
  onColumnDrop,
  onSort,
  sortBy,
  sortDirection
}: {
  columnOrder: InventoryColumnKey[];
  draggedColumn?: InventoryColumnKey;
  inventory: SnapshotVmInventoryResponse;
  onColumnDragStart: (column: InventoryColumnKey | undefined) => void;
  onColumnDrop: (column: InventoryColumnKey) => void;
  onSort: (sortBy: SnapshotVmInventorySortKey) => void;
  sortBy?: SnapshotVmInventorySortKey;
  sortDirection?: SnapshotVmInventorySortDirection;
}) {
  const columns = orderedInventoryColumns(columnOrder);
  return (
    <section className="table-card inventory-table-card" aria-labelledby="inventory-table-title">
      <div className="table-title">
        <h3 id="inventory-table-title">VM Details</h3>
        <span className="table-hint">Drag headers to reorder columns</span>
      </div>
      <div className="table-scroll inventory-table-scroll">
        <table className="data-table inventory-data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={draggedColumn === column.key ? "dragging-column" : undefined}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    onColumnDragStart(column.key);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragEnd={() => onColumnDragStart(undefined)}
                  onDrop={() => onColumnDrop(column.key)}
                >
                  <div className="column-header">
                    <GripVertical aria-hidden="true" size={14} />
                    {column.sortable ? (
                      <button
                        className="sort-button"
                        type="button"
                        onClick={() => onSort(column.sortable!)}
                        aria-label={`Sort by ${column.label}`}
                      >
                        <span>{column.label}</span>
                        <ArrowUpDown aria-hidden="true" size={14} />
                        {sortBy === column.sortable && <span className="sort-direction">{sortDirection === "desc" ? "Desc" : "Asc"}</span>}
                      </button>
                    ) : (
                      <span>{column.label}</span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {inventory.rows.length === 0 ? (
              <tr>
                <td className="empty-table-cell" colSpan={columns.length}>
                  No VMs match the current filters
                </td>
              </tr>
            ) : (
              inventory.rows.map((vm) => (
                <tr key={`${vm.managerId}:${vm.vmId}`}>
                  {columns.map((column) => (
                    <td key={column.key} className={column.className}>
                      {column.render(vm)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ClusterVmTable({ vms }: { vms: DashboardClusterVm[] }) {
  return (
    <section className="table-card" aria-labelledby="cluster-vm-table-title">
      <div className="table-title">
        <h3 id="cluster-vm-table-title">VMs</h3>
      </div>
      <div className="table-scroll">
        <table className="data-table adaptive-data-table cluster-vm-data-table">
          <thead>
            <tr>
              <th scope="col">VM Name</th>
              <th scope="col">Environment</th>
              <th scope="col">Power State</th>
              <th scope="col">Host</th>
              <th scope="col">Guest OS</th>
              <th scope="col">IP Address</th>
              <th scope="col">vCPU Count</th>
              <th scope="col">Allocated RAM</th>
              <th scope="col">Storage Allocated / Used</th>
            </tr>
          </thead>
          <tbody>
            {vms.length === 0 ? (
              <tr>
                <td className="empty-table-cell" colSpan={9}>
                  No VMs collected for this cluster
                </td>
              </tr>
            ) : (
              vms.map((vm) => (
                <tr key={vm.vmId}>
                  <td>{vm.name}</td>
                  <td>{vm.environment ?? "-"}</td>
                  <td>{vm.powerState ?? "-"}</td>
                  <td>{vm.host ?? "-"}</td>
                  <td>{vm.guestOs ?? "-"}</td>
                  <td>{vm.ipAddress ?? "-"}</td>
                  <td>{vm.vcpuCount ?? "-"}</td>
                  <td>{formatMemory(vm.allocatedRamMiB)}</td>
                  <td>{formatStorage(vm)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: SnapshotSummary["status"] }) {
  return <span className={`state-pill ${statusClass(status)}`}>{status}</span>;
}

function SnapshotStatusIcon({ status }: { status: SnapshotSummary["status"] }) {
  if (status === "success") {
    return <CheckCircle2 aria-hidden="true" size={16} />;
  }
  if (status === "partial") {
    return <AlertTriangle aria-hidden="true" size={16} />;
  }
  return <XCircle aria-hidden="true" size={16} />;
}

function formatResourceCounts(counts: SnapshotSummary["resourceCounts"]) {
  return Object.entries(counts)
    .map(([resource, count]) => `${formatResourceName(resource)}: ${count}`)
    .join(", ");
}

function managerInputFromForm(formElement: HTMLFormElement): {
  input: ManagerInput & { name: string; url: string };
  username: string;
  password: string;
} {
  const form = new FormData(formElement);
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  const input = {
    name: String(form.get("name") ?? ""),
    url: String(form.get("url") ?? ""),
    enabled: form.get("enabled") === "on",
    ignoreTls: form.get("ignoreTls") === "on",
    ...(username || password ? { username, password } : {})
  };

  return { input, username, password };
}

function statusClass(status: SnapshotSummary["status"]) {
  if (status === "success") {
    return "status-success";
  }
  if (status === "partial") {
    return "status-warning";
  }
  return "status-danger";
}

function countActiveInventoryFilters(filters: SnapshotVmInventoryFilters) {
  return [filters.search, filters.managerId, filters.clusterId, filters.powerState].filter(Boolean).length;
}

function latestInventoryCollectedAt(rows: SnapshotVmInventoryRow[] | undefined) {
  const times = (rows ?? []).map((row) => Date.parse(row.collectedAt)).filter((value) => Number.isFinite(value));
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
}

function matchesSnapshotFilters(snapshot: SnapshotSummary, filters: SnapshotFilters) {
  return (!filters.managerId || snapshot.managerId === filters.managerId) && (!filters.status || snapshot.status === filters.status);
}

function uniqueSnapshotManagers(snapshots: SnapshotSummary[]) {
  const managers = new Map<string, string>();
  for (const snapshot of snapshots) {
    if (!managers.has(snapshot.managerId)) {
      managers.set(snapshot.managerId, snapshot.managerName);
    }
  }
  return [...managers.entries()].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label));
}

function uniqueSnapshotStatuses(snapshots: SnapshotSummary[]) {
  return [...new Set(snapshots.map((snapshot) => snapshot.status))].sort();
}

function formatResourceName(resource: string) {
  return resource.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function orderedInventoryColumns(order: InventoryColumnKey[]) {
  const columnsByKey = new Map(inventoryColumns.map((column) => [column.key, column]));
  const ordered = order.map((key) => columnsByKey.get(key)).filter((column): column is InventoryColumn => Boolean(column));
  const missing = inventoryColumns.filter((column) => !order.includes(column.key));
  return [...ordered, ...missing];
}

function reorderInventoryColumns(order: InventoryColumnKey[], source: InventoryColumnKey, target: InventoryColumnKey) {
  const nextOrder = orderedInventoryColumns(order).map((column) => column.key);
  const sourceIndex = nextOrder.indexOf(source);
  const targetIndex = nextOrder.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0) {
    return nextOrder;
  }
  const [moved] = nextOrder.splice(sourceIndex, 1);
  nextOrder.splice(targetIndex, 0, moved);
  return nextOrder;
}

function savedViewFilters(view: SavedView): SnapshotVmInventoryFilters {
  const filters = view.filters;
  const sort = view.sort;
  return {
    search: stringRecordValue(filters.search),
    managerId: stringRecordValue(filters.managerId),
    clusterId: stringRecordValue(filters.clusterId),
    powerState: stringRecordValue(filters.powerState),
    sortBy: inventorySortKey(sort.sortBy) ?? inventorySortKey(filters.sortBy),
    sortDirection: inventorySortDirection(sort.sortDirection) ?? inventorySortDirection(filters.sortDirection),
    page: 1,
    pageSize: positiveRecordNumber(filters.pageSize) ?? 100
  };
}

function savedViewColumns(view: SavedView): InventoryColumnKey[] {
  const validColumns = new Set(defaultInventoryColumnOrder);
  const columns = view.columns.filter((column): column is InventoryColumnKey => validColumns.has(column as InventoryColumnKey));
  return columns.length ? columns : defaultInventoryColumnOrder;
}

function compactInventoryFilters(filters: SnapshotVmInventoryFilters): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["search", "managerId", "clusterId", "powerState", "pageSize"] as const) {
    const value = filters[key];
    if (value !== undefined && value !== "") {
      result[key] = value;
    }
  }
  return result;
}

function inventorySortKey(value: unknown): SnapshotVmInventorySortKey | undefined {
  return inventoryColumns.some((column) => column.sortable === value) ? (value as SnapshotVmInventorySortKey) : undefined;
}

function inventorySortDirection(value: unknown): SnapshotVmInventorySortDirection | undefined {
  return value === "asc" || value === "desc" ? value : undefined;
}

function stringRecordValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function positiveRecordNumber(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function formatNumber(value: number | undefined) {
  return value === undefined ? "-" : value.toLocaleString();
}

function formatIpAddresses(vm: SnapshotVmInventoryRow) {
  const addresses = vm.ipAddresses?.length ? vm.ipAddresses : vm.ipAddress ? [vm.ipAddress] : [];
  return addresses.length ? addresses.join(", ") : "-";
}

function formatSnapshotNames(vm: SnapshotVmInventoryRow) {
  return vm.snapshotNames.length ? vm.snapshotNames.join(", ") : "-";
}

function formatMemory(value: number | undefined) {
  if (value === undefined) {
    return "-";
  }
  const gib = value / 1024;
  return `${value.toLocaleString()} MiB (~${formatRoundedGib(gib)} GiB)`;
}

function formatStorage(vm: DashboardClusterVm) {
  const allocated = formatGib(vm.storageAllocatedGiB);
  const used = formatGib(vm.storageUsedGiB);
  return allocated === "-" && used === "-" ? "-" : `${allocated} / ${used}`;
}

function formatVmStorage(vm: SnapshotVmInventoryRow) {
  const allocated = formatGib(vm.storageAllocatedGiB);
  const used = formatGib(vm.storageUsedGiB);
  return allocated === "-" && used === "-" ? "-" : `${allocated} / ${used}`;
}

function inventoryFilterKey(filters: SnapshotVmInventoryFilters) {
  return JSON.stringify(filters);
}

function formatGib(value: number | undefined) {
  return value === undefined ? "-" : `${value.toLocaleString()} GiB`;
}

function formatRoundedGib(value: number) {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function clusterHash(managerId: string, clusterId: string) {
  return `#cluster/${encodeURIComponent(managerId)}/${encodeURIComponent(clusterId)}`;
}

function clusterParamsFromHash(hash: string): { managerId: string; clusterId: string } | undefined {
  const [page, managerId, clusterId] = hash.replace(/^#/, "").split("/");
  if (page !== "cluster" || !managerId || !clusterId) {
    return undefined;
  }
  return { managerId: decodeURIComponent(managerId), clusterId: decodeURIComponent(clusterId) };
}

function pageFromHash(): PageId {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("cluster/")) {
    return "cluster";
  }
  if (hash === "inventory") {
    return "inventory";
  }
  if (hash === "capacity") {
    return "capacity";
  }
  if (hash === "relationships") {
    return "relationships";
  }
  if (hash === "managers" || hash === "manager-title") {
    return "managers";
  }
  if (hash === "history" || hash === "snapshot-title") {
    return "history";
  }
  if (hash === "settings") {
    return "settings";
  }
  return "dashboard";
}
