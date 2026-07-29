#!/usr/bin/env python3
"""Ansible dynamic inventory for oVirt hosts and virtual machines.

Required environment: OVIRT_ENDPOINTS_FILE, a JSON endpoint registry.
Each endpoint names its URL and environment variables for credentials.
"""

import argparse
import base64
import json
import os
import re
import ssl
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


PAGE_SIZE = 1000


def items(value, key):
    if isinstance(value, dict) and key in value:
        value = value.get(key, [])
    return value if isinstance(value, list) else [value] if isinstance(value, dict) else []


def first_ip(vm):
    for nic in items(vm.get("nics"), "nic"):
        for device in items(nic.get("reported_devices"), "reported_device"):
            for ip in items(device.get("ips"), "ip"):
                if ip.get("address"):
                    return ip["address"]
    return ""


def relation_id(item, field):
    value = item.get(field)
    return value.get("id", "") if isinstance(value, dict) else ""


def add_resources(inventory, endpoint, group, global_group, prefix, resource_type, rows, address):
    for row in rows:
        resource_id = str(row["id"])
        name = f"ovirt_{endpoint}_{prefix}_{resource_id}"
        hostvars = {
            "ovirt_id": resource_id,
            "ovirt_name": row.get("name", ""),
            "ovirt_type": resource_type,
            "ovirt_endpoint": endpoint,
            "ovirt_status": row.get("status", ""),
            "ovirt_cluster_id": relation_id(row, "cluster"),
        }
        if resource_type == "virtual_machine":
            hostvars["ovirt_hypervisor_id"] = relation_id(row, "host")
        connection_address = address(row)
        if connection_address:
            hostvars["ansible_host"] = connection_address
        inventory[group]["hosts"].append(name)
        inventory[global_group]["hosts"].append(name)
        inventory["_meta"]["hostvars"][name] = hostvars


def add_child(inventory, group):
    if group not in inventory["all"]["children"]:
        inventory["all"]["children"].append(group)


def build_inventory(inventories, errors):
    inventory = {
        "all": {"children": ["ovirt_hypervisors", "ovirt_vms"], "vars": {"ovirt_endpoint_errors": errors}},
        "ovirt_hypervisors": {"hosts": []},
        "ovirt_vms": {"hosts": []},
        "_meta": {"hostvars": {}},
    }
    for endpoint in sorted(set(inventories) | set(errors)):
        endpoint_group = f"ovirt_{endpoint}"
        host_group = f"{endpoint_group}_hypervisors"
        vm_group = f"{endpoint_group}_vms"
        inventory[endpoint_group] = {"children": [host_group, vm_group]}
        inventory[host_group] = {"hosts": []}
        inventory[vm_group] = {"hosts": []}
        add_child(inventory, endpoint_group)
        hosts, vms = inventories.get(endpoint, ([], []))
        add_resources(inventory, endpoint, host_group, "ovirt_hypervisors", "host", "hypervisor", hosts, lambda host: host.get("address") or host.get("name"))
        add_resources(inventory, endpoint, vm_group, "ovirt_vms", "vm", "virtual_machine", vms, lambda vm: vm.get("fqdn") or first_ip(vm) or vm.get("name"))
    return inventory


def api_url(value):
    url = value.rstrip("/")
    parsed = urlsplit(url)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("endpoint url must be an http(s) URL without a query or fragment")
    return url if url.endswith("/ovirt-engine/api") else f"{url}/ovirt-engine/api"


def endpoint_key(value):
    key = re.sub(r"[^a-z0-9_]+", "_", value.lower()).strip("_")
    if not key or key in {"hypervisors", "vms"}:
        raise ValueError("endpoint name must produce a unique Ansible group name")
    return key


def require_string(endpoint, field):
    value = endpoint.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"endpoint {field} must be a non-empty string")
    return value.strip()


def load_endpoints(environment):
    path = environment.get("OVIRT_ENDPOINTS_FILE")
    if not path:
        raise ValueError("set OVIRT_ENDPOINTS_FILE to an endpoint registry JSON file")
    with open(path, encoding="utf-8") as config_file:
        config = json.load(config_file)
    endpoints = config.get("endpoints") if isinstance(config, dict) else config
    if not isinstance(endpoints, list) or not endpoints:
        raise ValueError("endpoint registry must contain a non-empty endpoints array")
    result = []
    names = set()
    for endpoint in endpoints:
        if not isinstance(endpoint, dict):
            raise ValueError("each endpoint must be a JSON object")
        name = endpoint_key(require_string(endpoint, "name"))
        if name in names:
            raise ValueError(f"duplicate endpoint name: {name}")
        names.add(name)
        url = require_string(endpoint, "url")
        api_url(url)
        token_env = endpoint.get("token_env")
        username_env = endpoint.get("username_env")
        password_env = endpoint.get("password_env")
        if token_env is not None:
            if not isinstance(token_env, str) or not token_env or username_env is not None or password_env is not None:
                raise ValueError(f"endpoint {name} must use token_env or username_env/password_env")
        elif not all(isinstance(value, str) and value for value in (username_env, password_env)):
            raise ValueError(f"endpoint {name} must use token_env or username_env/password_env")
        if "insecure" in endpoint and not isinstance(endpoint["insecure"], bool):
            raise ValueError(f"endpoint {name} insecure must be true or false")
        if "ca_file" in endpoint and not isinstance(endpoint["ca_file"], str):
            raise ValueError(f"endpoint {name} ca_file must be a string")
        result.append({**endpoint, "name": name, "url": url})
    return result


def auth_headers(endpoint, environment):
    token_env = endpoint.get("token_env")
    if token_env:
        token = environment.get(token_env)
        if not token:
            raise ValueError(f"{token_env} is not set")
        return {"Accept": "application/json", "Authorization": f"Bearer {token}"}
    username = environment.get(endpoint["username_env"])
    password = environment.get(endpoint["password_env"])
    if not username or password is None:
        raise ValueError(f"set {endpoint['username_env']} and {endpoint['password_env']}")
    credentials = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Accept": "application/json", "Authorization": f"Basic {credentials}"}


def ssl_context(endpoint):
    if endpoint.get("insecure", False):
        return ssl._create_unverified_context()
    return ssl.create_default_context(cafile=endpoint.get("ca_file") or None)


def get_json(url, headers, context, timeout):
    try:
        with urlopen(Request(url, headers=headers), context=context, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"oVirt returned HTTP {error.code}") from error
    except URLError as error:
        raise RuntimeError(f"could not reach oVirt: {error.reason}") from error


def list_resources(base_url, resource, item_key, headers, context, timeout, follow=""):
    result = []
    seen = set()
    page = 1
    while True:
        query = {"max": PAGE_SIZE, "page": page}
        if follow:
            query["follow"] = follow
        payload = get_json(f"{base_url}/{resource}?{urlencode(query, safe=',')}", headers, context, timeout)
        if not isinstance(payload, dict) or not isinstance(payload.get(item_key, []), (list, dict)):
            raise RuntimeError("oVirt returned an invalid collection response")
        rows = items(payload.get(item_key), item_key)
        if not rows:
            return result
        added = False
        for row in rows:
            if isinstance(row, dict) and row.get("id") and row["id"] not in seen:
                seen.add(row["id"])
                result.append(row)
                added = True
        if len(rows) < PAGE_SIZE or not added:
            return result
        page += 1


def endpoint_resources(endpoint, timeout, environment):
    base_url = api_url(endpoint["url"])
    headers = auth_headers(endpoint, environment)
    context = ssl_context(endpoint)
    hosts = list_resources(base_url, "hosts", "host", headers, context, timeout)
    vms = list_resources(base_url, "vms", "vm", headers, context, timeout, "nics,nics.reporteddevices")
    return hosts, vms


def ovirt_inventory(environment):
    timeout = float(environment.get("OVIRT_TIMEOUT", "30"))
    if timeout <= 0:
        raise ValueError("OVIRT_TIMEOUT must be greater than zero")
    inventories = {}
    errors = {}
    for endpoint in load_endpoints(environment):
        try:
            inventories[endpoint["name"]] = endpoint_resources(endpoint, timeout, environment)
        except (OSError, RuntimeError, ValueError) as error:
            errors[endpoint["name"]] = str(error)
            print(f"ovirt_inventory: {endpoint['name']}: {error}", file=sys.stderr)
    return build_inventory(inventories, errors)


def self_test():
    inventory = build_inventory(
        {"production": (
            [{"id": "host-1", "name": "hypervisor-1", "address": "192.0.2.10", "status": "up"}],
            [
                {"id": "vm-1", "name": "vm-1", "fqdn": "vm-1.example.test", "status": "up"},
                {"id": "vm-2", "name": "vm-2", "nics": {"nic": [{"reported_devices": {"reported_device": [{"ips": {"ip": [{"address": "192.0.2.20"}]}}]}}]}},
            ],
        )},
        {"lab": "could not reach oVirt: timed out"},
    )
    assert inventory["ovirt_production_hypervisors"]["hosts"] == ["ovirt_production_host_host-1"]
    assert inventory["_meta"]["hostvars"]["ovirt_production_vm_vm-1"]["ansible_host"] == "vm-1.example.test"
    assert inventory["_meta"]["hostvars"]["ovirt_production_vm_vm-2"]["ansible_host"] == "192.0.2.20"
    assert inventory["all"]["vars"]["ovirt_endpoint_errors"] == {"lab": "could not reach oVirt: timed out"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--list", action="store_true", help="print the complete inventory")
    action.add_argument("--host", help="print variables for one inventory hostname")
    action.add_argument("--self-test", action="store_true", help="run the local inventory check")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    inventory = ovirt_inventory(os.environ)
    print(json.dumps(inventory if args.list else inventory["_meta"]["hostvars"].get(args.host, {}), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"ovirt_inventory: {error}", file=sys.stderr)
        sys.exit(1)
