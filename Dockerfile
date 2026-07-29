FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91

ARG VERSION=dev

RUN pip install --no-cache-dir ansible-core==2.18.8

COPY --chmod=755 ovirt_inventory.py /opt/ovirt-inventory/ovirt_inventory.py

LABEL org.opencontainers.image.source="https://github.com/dennis-au/ovirt_inventory" \
      org.opencontainers.image.version="${VERSION}"

CMD ["ansible-inventory", "-i", "/opt/ovirt-inventory/ovirt_inventory.py", "--list"]
