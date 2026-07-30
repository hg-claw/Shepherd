/**
 * Compares only major.minor, which is all the sing-box 1.14 boundary needs.
 * Tolerates a leading "v" and any pre-release suffix, so "v1.14.0-beta.2"
 * counts as 1.14. Unparseable input returns false — deployed_version is
 * free-form and an unknown value must not silently pass a gate.
 *
 * Mirrors singboxMinorAtLeast in internal/plugins/singbox/version_gate.go.
 * Keep the two in sync.
 */
export function singboxMinorAtLeast(
  version: string | null | undefined,
  wantMajor: number,
  wantMinor: number,
): boolean {
  if (!version) return false
  let s = version.trim().replace(/^v/, '')
  const cut = s.search(/[-+]/)
  if (cut >= 0) s = s.slice(0, cut)
  const parts = s.split('.')
  if (parts.length < 2) return false
  const major = Number(parts[0])
  const minor = Number(parts[1])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false
  if (major !== wantMajor) return major > wantMajor
  return minor >= wantMinor
}
