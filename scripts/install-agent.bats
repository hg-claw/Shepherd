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
