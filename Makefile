.PHONY: web web-clean server server-no-web agent agents agent-amd64 agent-arm64 \
        release docker-build test test-go test-web fmt vet tidy

VERSION ?= dev

web:
	cd web && npm install && npm run build

web-clean:
	rm -rf internal/web/dist
	mkdir -p internal/web/dist
	touch internal/web/dist/.gitkeep

# Build agent for both Linux arches into the embed directory the server uses.
agents: agent-amd64 agent-arm64

agent-amd64:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
	  -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=$(VERSION)" \
	  -o internal/installer/bin/shepherd-agent-linux-amd64 ./cmd/agent

agent-arm64:
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build \
	  -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=$(VERSION)" \
	  -o internal/installer/bin/shepherd-agent-linux-arm64 ./cmd/agent

# `server` builds the host-arch server binary; depends on web (for embed)
# and agents (so installer.bin/* contains real binaries, not just the
# .gitkeep placeholder).
server: web agents
	go build \
	  -ldflags "-X github.com/hg-claw/Shepherd/internal/config.BuildVersion=$(VERSION)" \
	  -o bin/shepherd-server ./cmd/server

# Skip web + agents — for environments without npm or for quick Go iteration.
server-no-web:
	go build -o bin/shepherd-server ./cmd/server

agent:
	go build -o bin/shepherd-agent ./cmd/agent

# Local release: cross-compile server + agent for both Linux arches, package
# tar.gz + sha256. Requires Linux host (CGO cross-compile from macOS to Linux
# is not set up; CI does it via QEMU). Use as: make release VERSION=v0.1.0
release: web agents
	@if [ -z "$(VERSION)" ] || [ "$(VERSION)" = "dev" ]; then \
	  echo "VERSION required (e.g. make release VERSION=v0.1.0)"; exit 1; fi
	@if [ "$$(uname -s)" != "Linux" ]; then \
	  echo "WARNING: make release works fully only on Linux hosts."; \
	  echo "On macOS/Windows the arm64 server build will fail without a"; \
	  echo "cross-compiler. Use the GitHub Actions release workflow instead."; \
	fi
	rm -rf dist && mkdir -p dist
	@for arch in amd64 arm64; do \
	  echo ">> server linux/$$arch"; \
	  GOOS=linux GOARCH=$$arch CGO_ENABLED=1 \
	    go build \
	    -ldflags "-X github.com/hg-claw/Shepherd/internal/config.BuildVersion=$(VERSION)" \
	    -o dist/shepherd-server-linux-$$arch \
	    ./cmd/server || exit 1; \
	  cp internal/installer/bin/shepherd-agent-linux-$$arch dist/shepherd-agent-linux-$$arch; \
	  tar -czf dist/shepherd-linux-$$arch.tar.gz -C dist shepherd-server-linux-$$arch shepherd-agent-linux-$$arch; \
	  (cd dist && sha256sum shepherd-linux-$$arch.tar.gz > shepherd-linux-$$arch.tar.gz.sha256); \
	done
	@echo "Release artifacts:"
	@ls -lh dist/

# Local single-arch Docker image build. Uses the host's docker; no buildx required.
# Use as: make docker-build VERSION=v0.1.0
docker-build:
	docker build -t shepherd:$(VERSION) --build-arg VERSION=$(VERSION) .

test: test-go test-web

test-go:
	go test ./...

test-web:
	cd web && npm test

fmt:
	gofmt -w .

vet:
	go vet ./...

tidy:
	go mod tidy
