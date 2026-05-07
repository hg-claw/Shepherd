# syntax=docker/dockerfile:1.7

# ── Stage 1: web build (node) ─────────────────────────────────────
# Pinned to BUILDPLATFORM so npm runs natively even when targeting a
# non-host arch — the JS bundle is platform-independent.
FROM --platform=$BUILDPLATFORM node:20-alpine AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# Vite's `outDir: '../internal/web/dist'` writes to /src/internal/web/dist.
RUN npm run build

# ── Stage 2: go build ─────────────────────────────────────────────
# NO --platform pin: under buildx this stage runs natively for the target
# arch (via QEMU when host != target). That lets CGO=1 work for the SQLite
# driver without setting up a cross-compiler.
FROM golang:1.22-alpine AS go-builder
RUN apk add --no-cache build-base sqlite-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-builder /src/internal/web/dist ./internal/web/dist
ARG VERSION=dev
# Cross-compile both agent arches into the embed dir so any-arch server
# image can install agents on either-arch hosts. Agents are pure Go (CGO=0)
# and cross-compile cleanly without a C toolchain.
RUN GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
      -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=${VERSION}" \
      -o internal/installer/bin/shepherd-agent-linux-amd64 ./cmd/agent && \
    GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build \
      -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=${VERSION}" \
      -o internal/installer/bin/shepherd-agent-linux-arm64 ./cmd/agent
# Server: native build for the (QEMU-emulated) target arch. CGO=1 for sqlite.
RUN CGO_ENABLED=1 go build \
      -ldflags "-X github.com/hg-claw/Shepherd/internal/config.BuildVersion=${VERSION}" \
      -o /out/shepherd-server ./cmd/server

# ── Stage 3: runtime ──────────────────────────────────────────────
FROM alpine:3.19 AS runtime
RUN apk add --no-cache ca-certificates sqlite-libs && \
    addgroup -S shep && adduser -S -G shep shep && \
    mkdir -p /data && chown shep:shep /data
COPY --from=go-builder /out/shepherd-server /usr/local/bin/shepherd-server
EXPOSE 8080
USER shep
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/shepherd-server"]
