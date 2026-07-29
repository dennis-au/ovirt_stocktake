IMAGE ?= ghcr.io/dennis-au/ovirt_inventory
VERSION ?= latest
PLATFORMS ?= linux/amd64,linux/arm64

.PHONY: push
push:
	docker buildx build --platform $(PLATFORMS) --build-arg VERSION=$(VERSION) --tag $(IMAGE):$(VERSION) --push .
