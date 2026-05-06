.PHONY: web web-clean server server-no-web agent test test-go test-web fmt vet tidy

web:
	cd web && npm install && npm run build

web-clean:
	rm -rf internal/web/dist
	mkdir -p internal/web/dist
	touch internal/web/dist/.gitkeep

# Build the server binary. Builds the frontend first to embed real dist
# content; if you don't have npm available, use `make server-no-web`.
server: web
	go build -o bin/shepherd-server ./cmd/server

# For environments without npm (CI go-only runs, quick iteration):
server-no-web:
	go build -o bin/shepherd-server ./cmd/server

agent:
	go build -o bin/shepherd-agent ./cmd/agent

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
