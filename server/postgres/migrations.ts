export interface PostgresMigration {
  id: string;
  sql: string;
}

export const postgresMigrations: PostgresMigration[] = [
  {
    id: "001_inventory_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS managers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        credential_status TEXT NOT NULL DEFAULT 'missing',
        credential_ciphertext TEXT,
        credential_nonce TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS collection_runs (
        id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'running')),
        api_version TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        duration_ms INTEGER,
        warnings JSONB NOT NULL DEFAULT '[]',
        errors JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS data_centers (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        data_center_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT,
        last_seen_at TIMESTAMPTZ NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, data_center_id)
      );

      CREATE TABLE IF NOT EXISTS clusters (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        cluster_id TEXT NOT NULL,
        data_center_id TEXT,
        name TEXT NOT NULL,
        cpu_type TEXT,
        version TEXT,
        last_seen_at TIMESTAMPTZ NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, cluster_id)
      );

      CREATE TABLE IF NOT EXISTS hosts (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        host_id TEXT NOT NULL,
        cluster_id TEXT,
        name TEXT NOT NULL,
        status TEXT,
        maintenance BOOLEAN,
        last_seen_at TIMESTAMPTZ NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, host_id)
      );

      CREATE TABLE IF NOT EXISTS storage_domains (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        storage_domain_id TEXT NOT NULL,
        data_center_id TEXT,
        name TEXT NOT NULL,
        status TEXT,
        storage_type TEXT,
        total_bytes BIGINT,
        used_bytes BIGINT,
        available_bytes BIGINT,
        last_seen_at TIMESTAMPTZ NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, storage_domain_id)
      );

      CREATE TABLE IF NOT EXISTS logical_networks (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        network_id TEXT NOT NULL,
        data_center_id TEXT,
        name TEXT NOT NULL,
        vlan_id INTEGER,
        last_seen_at TIMESTAMPTZ NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, network_id)
      );

      CREATE TABLE IF NOT EXISTS vnic_profiles (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        vnic_profile_id TEXT NOT NULL,
        network_id TEXT,
        name TEXT NOT NULL,
        qos TEXT,
        port_mirroring BOOLEAN,
        last_seen_at TIMESTAMPTZ NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, vnic_profile_id)
      );

      CREATE TABLE IF NOT EXISTS vms (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        vm_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        comment TEXT,
        created_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ NOT NULL,
        status TEXT,
        status_detail TEXT,
        cluster_id TEXT,
        cluster_name TEXT,
        data_center_id TEXT,
        data_center_name TEXT,
        host_id TEXT,
        host_name TEXT,
        preferred_host TEXT,
        migration_policy TEXT,
        last_started_at TIMESTAMPTZ,
        last_stopped_at TIMESTAMPTZ,
        uptime_seconds BIGINT,
        ha_enabled BOOLEAN,
        ha_priority INTEGER,
        watchdog_type TEXT,
        watchdog_action TEXT,
        migration_count_30d INTEGER,
        vcpus INTEGER,
        sockets INTEGER,
        cores_per_socket INTEGER,
        threads_per_core INTEGER,
        cpu_profile TEXT,
        cpu_pinning TEXT,
        numa_pinning TEXT,
        memory_mb INTEGER,
        max_memory_mb INTEGER,
        guaranteed_memory_mb INTEGER,
        memory_ballooning BOOLEAN,
        hugepages TEXT,
        os_type TEXT,
        guest_os_name TEXT,
        guest_os_version TEXT,
        kernel_version TEXT,
        hostname TEXT,
        fqdn TEXT,
        guest_agent_status TEXT,
        guest_agent_version TEXT,
        last_guest_agent_update TIMESTAMPTZ,
        bios_type TEXT,
        secure_boot BOOLEAN,
        boot_order JSONB NOT NULL DEFAULT '[]',
        health_score INTEGER,
        health_deductions JSONB NOT NULL DEFAULT '[]',
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, vm_id)
      );

      CREATE TABLE IF NOT EXISTS vm_ownership (
        manager_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        environment TEXT,
        application TEXT,
        service_role TEXT,
        owner TEXT,
        on_call_group TEXT,
        cost_center TEXT,
        criticality TEXT,
        cmdb_ci_id TEXT,
        ticket_reference TEXT,
        backup_policy TEXT,
        backup_status TEXT,
        last_backup_success_at TIMESTAMPTZ,
        last_backup_attempt_at TIMESTAMPTZ,
        rpo_target_hours INTEGER,
        rpo_actual_hours INTEGER,
        rto_target_hours INTEGER,
        last_restore_test_at TIMESTAMPTZ,
        backup_excluded_disks JSONB NOT NULL DEFAULT '[]',
        os_eol_date DATE,
        last_patch_at TIMESTAMPTZ,
        edr_status TEXT,
        vulnerability_critical_count INTEGER,
        public_ip TEXT,
        lifecycle_status TEXT,
        retire_date DATE,
        monthly_estimated_cost NUMERIC(14, 2),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (manager_id, vm_id),
        FOREIGN KEY (manager_id, vm_id) REFERENCES vms(manager_id, vm_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS vm_nics (
        manager_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        nic_id TEXT NOT NULL,
        nic_name TEXT NOT NULL,
        mac_address TEXT,
        vnic_profile_id TEXT,
        vnic_profile TEXT,
        logical_network TEXT,
        vlan_id INTEGER,
        interface_type TEXT,
        linked BOOLEAN,
        ipv4_addresses JSONB NOT NULL DEFAULT '[]',
        ipv6_addresses JSONB NOT NULL DEFAULT '[]',
        network_filter TEXT,
        qos TEXT,
        port_mirroring BOOLEAN,
        last_seen_at TIMESTAMPTZ NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, vm_id, nic_id),
        FOREIGN KEY (manager_id, vm_id) REFERENCES vms(manager_id, vm_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS vm_disks (
        manager_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        disk_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        storage_domain_id TEXT,
        storage_domain TEXT,
        disk_format TEXT,
        provisioned_size_gib NUMERIC(14, 2),
        actual_size_gib NUMERIC(14, 2),
        interface TEXT,
        bootable BOOLEAN,
        shareable BOOLEAN,
        backup_included BOOLEAN,
        disk_profile TEXT,
        direct_lun TEXT,
        encrypted BOOLEAN,
        last_seen_at TIMESTAMPTZ NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, vm_id, disk_id),
        FOREIGN KEY (manager_id, vm_id) REFERENCES vms(manager_id, vm_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS vm_snapshots (
        manager_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ,
        status TEXT,
        snapshot_type TEXT,
        age_days INTEGER,
        size_gib NUMERIC(14, 2),
        creator TEXT,
        ticket_reference TEXT,
        last_seen_at TIMESTAMPTZ NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, vm_id, snapshot_id),
        FOREIGN KEY (manager_id, vm_id) REFERENCES vms(manager_id, vm_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tags (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        tag_name TEXT NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, tag_name)
      );

      CREATE TABLE IF NOT EXISTS vm_tags (
        manager_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        PRIMARY KEY (manager_id, vm_id, tag_name),
        FOREIGN KEY (manager_id, vm_id) REFERENCES vms(manager_id, vm_id) ON DELETE CASCADE,
        FOREIGN KEY (manager_id, tag_name) REFERENCES tags(manager_id, tag_name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS affinity_groups (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        affinity_group_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enforcing BOOLEAN,
        positive BOOLEAN,
        last_seen_at TIMESTAMPTZ NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, affinity_group_id)
      );

      CREATE TABLE IF NOT EXISTS affinity_group_vms (
        manager_id TEXT NOT NULL,
        affinity_group_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        PRIMARY KEY (manager_id, affinity_group_id, vm_id),
        FOREIGN KEY (manager_id, affinity_group_id) REFERENCES affinity_groups(manager_id, affinity_group_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS events (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        event_time TIMESTAMPTZ NOT NULL,
        severity TEXT,
        resource_type TEXT,
        resource_id TEXT,
        message TEXT NOT NULL,
        raw_json JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, event_id)
      );

      CREATE TABLE IF NOT EXISTS inventory_history (
        id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        collection_run_id TEXT REFERENCES collection_runs(id) ON DELETE SET NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        collected_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resource_change_events (
        id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        collection_run_id TEXT REFERENCES collection_runs(id) ON DELETE SET NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        change_type TEXT NOT NULL,
        changed_at TIMESTAMPTZ NOT NULL,
        before_payload JSONB,
        after_payload JSONB
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor TEXT,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS saved_views (
        id TEXT PRIMARY KEY,
        owner_username TEXT NOT NULL,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        filters JSONB NOT NULL DEFAULT '{}',
        columns JSONB NOT NULL DEFAULT '[]',
        sort JSONB NOT NULL DEFAULT '{}',
        visibility TEXT NOT NULL DEFAULT 'private',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS exports (
        id TEXT PRIMARY KEY,
        requested_by TEXT NOT NULL,
        export_type TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('xlsx', 'csv', 'json')),
        filters JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        file_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_collection_runs_manager_started
        ON collection_runs (manager_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_data_centers_manager_name
        ON data_centers (manager_id, name);
      CREATE INDEX IF NOT EXISTS idx_clusters_manager_datacenter
        ON clusters (manager_id, data_center_id);
      CREATE INDEX IF NOT EXISTS idx_hosts_manager_cluster
        ON hosts (manager_id, cluster_id);
      CREATE INDEX IF NOT EXISTS idx_storage_domains_manager_datacenter
        ON storage_domains (manager_id, data_center_id);
      CREATE INDEX IF NOT EXISTS idx_storage_domains_capacity
        ON storage_domains (manager_id, used_bytes, total_bytes);
      CREATE INDEX IF NOT EXISTS idx_logical_networks_manager_datacenter
        ON logical_networks (manager_id, data_center_id);
      CREATE INDEX IF NOT EXISTS idx_vnic_profiles_network
        ON vnic_profiles (manager_id, network_id);
      CREATE INDEX IF NOT EXISTS idx_vms_manager_status
        ON vms (manager_id, status);
      CREATE INDEX IF NOT EXISTS idx_vms_manager_cluster
        ON vms (manager_id, cluster_id);
      CREATE INDEX IF NOT EXISTS idx_vms_manager_host
        ON vms (manager_id, host_id);
      CREATE INDEX IF NOT EXISTS idx_vms_last_seen
        ON vms (manager_id, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vms_health_score
        ON vms (manager_id, health_score);
      CREATE INDEX IF NOT EXISTS idx_vm_ownership_environment
        ON vm_ownership (manager_id, environment);
      CREATE INDEX IF NOT EXISTS idx_vm_ownership_owner
        ON vm_ownership (manager_id, owner);
      CREATE INDEX IF NOT EXISTS idx_vm_ownership_application
        ON vm_ownership (manager_id, application);
      CREATE INDEX IF NOT EXISTS idx_vm_ownership_criticality
        ON vm_ownership (manager_id, criticality);
      CREATE INDEX IF NOT EXISTS idx_vm_ownership_cost_center
        ON vm_ownership (manager_id, cost_center);
      CREATE INDEX IF NOT EXISTS idx_vm_nics_network
        ON vm_nics (manager_id, logical_network, vnic_profile);
      CREATE INDEX IF NOT EXISTS idx_vm_nics_ip
        ON vm_nics (manager_id, ipv4_addresses, ipv6_addresses);
      CREATE INDEX IF NOT EXISTS idx_vm_disks_storage_domain
        ON vm_disks (manager_id, storage_domain_id, storage_domain);
      CREATE INDEX IF NOT EXISTS idx_vm_snapshots_age
        ON vm_snapshots (manager_id, age_days);
      CREATE INDEX IF NOT EXISTS idx_vm_tags_tag
        ON vm_tags (manager_id, tag_name);
      CREATE INDEX IF NOT EXISTS idx_inventory_history_resource
        ON inventory_history (manager_id, resource_type, resource_id, collected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_change_events_resource
        ON resource_change_events (manager_id, resource_type, resource_id, changed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_manager_time
        ON events (manager_id, event_time DESC);
      CREATE INDEX IF NOT EXISTS idx_saved_views_owner_scope
        ON saved_views (owner_username, scope);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time
        ON audit_logs (action, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_exports_requested_by
        ON exports (requested_by, created_at DESC);
    `
  }
  ,
  {
    id: "002_vm_health_deductions",
    sql: `
      ALTER TABLE vms
      ADD COLUMN IF NOT EXISTS health_deductions JSONB NOT NULL DEFAULT '[]';
    `
  },
  {
    id: "003_metric_samples",
    sql: `
      CREATE TABLE IF NOT EXISTS metric_samples (
        manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        sampled_at TIMESTAMPTZ NOT NULL,
        value DOUBLE PRECISION NOT NULL,
        labels JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (manager_id, resource_type, resource_id, metric_name, sampled_at)
      );

      CREATE INDEX IF NOT EXISTS idx_metric_samples_resource_time
        ON metric_samples (manager_id, resource_type, resource_id, metric_name, sampled_at DESC);
    `
  }
];
