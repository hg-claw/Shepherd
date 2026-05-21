#!/usr/bin/env bats

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/install-agent.sh"
}

@test "detect_os: linux" {
  run bash -c "source '$SCRIPT' --source && uname() { echo Linux; }; detect_os"
  [ "$status" -eq 0 ]
  [ "$output" = "linux" ]
}

@test "detect_os: darwin" {
  run bash -c "source '$SCRIPT' --source && uname() { echo Darwin; }; detect_os"
  [ "$status" -eq 0 ]
  [ "$output" = "darwin" ]
}

@test "detect_os: unsupported" {
  run bash -c "source '$SCRIPT' --source && uname() { echo FreeBSD; }; detect_os"
  [ "$status" -ne 0 ]
}

@test "detect_arch: x86_64 → amd64" {
  run bash -c "source '$SCRIPT' --source && uname() { echo x86_64; }; detect_arch"
  [ "$status" -eq 0 ]
  [ "$output" = "amd64" ]
}

@test "detect_arch: aarch64 → arm64" {
  run bash -c "source '$SCRIPT' --source && uname() { echo aarch64; }; detect_arch"
  [ "$status" -eq 0 ]
  [ "$output" = "arm64" ]
}

@test "detect_arch: arm64 → arm64" {
  run bash -c "source '$SCRIPT' --source && uname() { echo arm64; }; detect_arch"
  [ "$status" -eq 0 ]
  [ "$output" = "arm64" ]
}

@test "detect_arch: unsupported" {
  run bash -c "source '$SCRIPT' --source && uname() { echo i386; }; detect_arch"
  [ "$status" -ne 0 ]
}

@test "parse_args: install" {
  run bash -c "source '$SCRIPT' --source && parse_args --token T --server https://x && echo \$MODE \$TOKEN \$SERVER_URL"
  [ "$status" -eq 0 ]
  [ "$output" = "install T https://x" ]
}

@test "parse_args: uninstall" {
  run bash -c "source '$SCRIPT' --source && parse_args --uninstall && echo \$MODE"
  [ "$status" -eq 0 ]
  [ "$output" = "uninstall" ]
}

@test "parse_args: install missing token" {
  run bash -c "source '$SCRIPT' --source && parse_args --server https://x"
  [ "$status" -ne 0 ]
}

@test "parse_args: install missing server" {
  run bash -c "source '$SCRIPT' --source && parse_args --token T"
  [ "$status" -ne 0 ]
}

@test "parse_args: optional --version" {
  run bash -c "source '$SCRIPT' --source && parse_args --token T --server https://x --version v0.5.0 && echo \$VERSION"
  [ "$status" -eq 0 ]
  [ "$output" = "v0.5.0" ]
}

@test "release_tag: --version override wins" {
  run bash -c "source '$SCRIPT' --source && VERSION=v0.5.0 && release_tag"
  [ "$status" -eq 0 ]
  [ "$output" = "v0.5.0" ]
}

@test "release_tag: defaults to v0.5.0 baseline when unset" {
  # Without VERSION, fall through to the embedded BUILD_TAG, which the
  # repo CI pipeline rewrites on release. For local script runs we use
  # a sane default.
  run bash -c "source '$SCRIPT' --source && unset VERSION; release_tag"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
}

@test "asset_url: linux amd64" {
  run bash -c "source '$SCRIPT' --source && asset_url linux amd64 v0.5.0"
  [ "$status" -eq 0 ]
  [ "$output" = "https://github.com/hg-claw/Shepherd/releases/download/v0.5.0/shepherd-linux-amd64.tar.gz" ]
}

@test "asset_url: darwin arm64" {
  run bash -c "source '$SCRIPT' --source && asset_url darwin arm64 v0.5.0"
  [ "$status" -eq 0 ]
  [ "$output" = "https://github.com/hg-claw/Shepherd/releases/download/v0.5.0/shepherd-agent-darwin-arm64.tar.gz" ]
}

@test "verify_sha256: match" {
  tmp=$(mktemp -d)
  echo hello > "$tmp/file"
  if command -v sha256sum >/dev/null; then
    sum=$(sha256sum "$tmp/file" | awk '{print $1}')
  else
    sum=$(shasum -a 256 "$tmp/file" | awk '{print $1}')
  fi
  echo "$sum  file" > "$tmp/file.sha256"
  run bash -c "source '$SCRIPT' --source && cd '$tmp' && verify_sha256 file file.sha256"
  [ "$status" -eq 0 ]
  rm -rf "$tmp"
}

@test "verify_sha256: mismatch" {
  tmp=$(mktemp -d)
  echo hello > "$tmp/file"
  echo "0000000000000000000000000000000000000000000000000000000000000000  file" > "$tmp/file.sha256"
  run bash -c "source '$SCRIPT' --source && cd '$tmp' && verify_sha256 file file.sha256"
  [ "$status" -ne 0 ]
  rm -rf "$tmp"
}
