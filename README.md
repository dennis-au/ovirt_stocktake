# oVirt Ansible Inventory

An Ansible dynamic inventory container for one or more oVirt Managers. It
emits `ovirt_hypervisors`, `ovirt_vms`, and endpoint groups such as
`ovirt_production`.

## Run

```sh
cp endpoints.example.json endpoints.json
docker build -t ovirt-inventory .
docker run --rm \
  --env-file .env.ovirt \
  -e OVIRT_ENDPOINTS_FILE=/config/endpoints.json \
  -v "$PWD/endpoints.json:/config/endpoints.json:ro" \
  ovirt-inventory
```

Set URLs and credential variable names in `endpoints.json`. Put credential
values in `.env.ovirt`; use either `username_env` and `password_env`, or
`token_env` per endpoint. `insecure: true` is only for self-signed lab
Managers. Unavailable Managers leave their endpoint groups empty while healthy
Managers remain available.

Run a playbook by mounting it and replacing the default command:

```sh
docker run --rm \
  --env-file .env.ovirt \
  -e OVIRT_ENDPOINTS_FILE=/config/endpoints.json \
  -v "$PWD/endpoints.json:/config/endpoints.json:ro" \
  -v "$PWD/playbooks:/work:ro" \
  ovirt-inventory \
  ansible-playbook -i /opt/ovirt-inventory/ovirt_inventory.py /work/site.yml
```

## Publish

```sh
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow builds a single `linux/amd64` and `linux/arm64`
manifest and publishes `ghcr.io/dennis-au/ovirt_inventory:0.1.0` and `latest`.
Pushes to `main` refresh `latest`.
