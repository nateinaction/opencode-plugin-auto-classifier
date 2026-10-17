// Identify which build of the plugin is running.
//
// OpenCode installs a Git plugin with npm, which records the resolved commit in
// the installer's lockfile (`<root>/node_modules/.package-lock.json`, beside
// the plugin's own directory). A long-lived server can hold several installs at
// once, so the commit is what tells their sidebar entries apart.
//
// Side-effect free; index.ts reads the files and passes their contents in.

const COMMIT = /#([0-9a-f]{7,40})$/

/** The short commit an npm lockfile resolved `name` to, if it records one. */
export function commitFromLock(lock: unknown, name: string): string | undefined {
  const packages = (lock as { packages?: Record<string, { resolved?: unknown }> } | null)?.packages
  const resolved = packages?.[`node_modules/${name}`]?.resolved
  if (typeof resolved !== "string") return undefined
  return COMMIT.exec(resolved)?.[1].slice(0, 7)
}

/** A build label: the installed commit, else the package version (e.g. a local checkout). */
export function buildLabel(commit: string | undefined, version: unknown): string {
  if (commit) return commit
  return typeof version === "string" && version ? `v${version}` : "unknown"
}
