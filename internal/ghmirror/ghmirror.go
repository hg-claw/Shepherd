package ghmirror

// Prefix wraps a github.com asset/script URL to route it through the
// gh-proxy.com mirror for mainland-China hosts. Single source for the Go side;
// scripts/install-agent.sh carries its own copy (a shell literal can't import).
const Prefix = "https://gh-proxy.com/"
