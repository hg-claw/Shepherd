.PHONY: server agent test fmt vet tidy

server:
	go build -o bin/shepherd-server ./cmd/server

agent:
	go build -o bin/shepherd-agent ./cmd/agent

test:
	go test ./...

fmt:
	gofmt -w .

vet:
	go vet ./...

tidy:
	go mod tidy
