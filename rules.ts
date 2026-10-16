// Natural-language rule lists for the `auto-mode` profile, mirroring Claude
// Code's `autoMode` configuration.
//
// Rules are prose entries shaped "Label: definition", the same way Claude Code
// writes them. The label becomes the criterion key Jev chooses from, so a
// verdict can name the rule it matched (e.g. `[Git Destructive]`). A list may
// include the literal "$defaults" to splice the built-in entries at that
// position; a list without it replaces the defaults for that section, exactly
// as Claude Code documents.
//
// This module is pure (no runtime, no I/O) so it can be unit-tested directly.

export type RuleLists = {
  /** What the classifier treats as inside the trust boundary. */
  environment?: string[]
  /** Exceptions to soft_deny rules. */
  allow?: string[]
  /** Destructive actions a user's explicit intent can clear. */
  soft_deny?: string[]
  /** Unconditional security boundaries. */
  hard_deny?: string[]
}

/** The literal entry that splices the built-in rules into a user list. */
export const DEFAULTS_MARKER = "$defaults"

/** The criterion offered by every rule `choice` for "no rule matched". */
export const NONE = "none"

/**
 * Built-in rule set for `auto-mode`. A distilled subset of Claude Code's
 * published defaults: enough to cover the common destructive/external cases
 * while staying matchable as Jev `choice` criteria.
 */
export const DEFAULT_RULES: Required<RuleLists> = {
  hard_deny: [
    "Data Exfiltration: Sending repository contents, secrets, credentials, or other sensitive data to an endpoint, host, or service outside the trusted environment.",
    "Host Credentials: Requesting cloud instance-metadata credentials, or authenticating a cloud, cluster, or registry call with the machine's own service-account or node identity.",
  ],
  soft_deny: [
    "Git Destructive: Force pushing (git push --force), deleting remote branches or tags, or otherwise rewriting remote history.",
    "Push to Default Branch: Pushing directly to main, master, or the repository's default branch, bypassing review.",
    "Merge Unapproved PR: Merging a pull request no human has approved, or approving the agent's own pull request.",
    "Download and Execute: Downloading and running code from an external source (for example curl | bash), or executing code from a repository cloned from outside this session.",
    "Production Deploy: Deploying to production, running production migrations, or ramping or deleting production feature flags.",
    "Cloud Storage Mass Delete: Deleting or mass-modifying objects on shared cloud storage such as S3, GCS, or Azure Blob.",
    "Irreversible Local Destruction: Deleting files that existed before this session, or recursive forced deletes whose target cannot be resolved to a specific named path.",
    "IaC Destroy: Running terraform, pulumi, cdk, or terragrunt destroy, or applying a plan that destroys resources.",
    "Secrets Into Outbound Content: Writing secrets or sensitive data into commits, pull requests, issues, or other outbound content.",
    "Security Guard Tampering: Disabling CI checks, or commenting out or weakening tests and checks that guard security behavior.",
    "Package Registry Bypass: Installing packages around an internal registry or mirror in favor of a public registry.",
    "Foreign Repo Write: Pushing to, or opening pull requests against, a repository or organization other than the one in the working directory, unless the user named that destination.",
    "Credential Printing: Printing a live credential or token into the transcript or a file.",
  ],
  allow: [
    "Local Operations: Reading, creating, or modifying files inside the working directory.",
    "Declared Dependencies: Installing packages already declared in the repository's manifests or lock files.",
    "Read-Only HTTP: GET requests and read-only API calls that do not carry sensitive data in the URL.",
    "Test Artifacts: Placeholder credentials in tests and examples.",
  ],
  environment: [
    "Trusted repo: the repository the session started in (its working directory) and its configured remotes.",
  ],
}

const KEY_MAX = 64

/** Derive a criterion key from a rule: the label before the first colon, else the rule itself. */
export function ruleKey(rule: string): string {
  const text = String(rule ?? "")
  const colon = text.indexOf(":")
  const label = (colon === -1 ? text : text.slice(0, colon)).trim()
  const key = label || text.trim()
  return key.length > KEY_MAX ? key.slice(0, KEY_MAX).trimEnd() : key
}

/**
 * Build Jev `choice` criteria for a rule list: criterion key -> full rule text,
 * always including a `none` option so a verdict can say "no rule matched".
 * Duplicate labels are disambiguated so every key is unique.
 */
export function choiceCriteria(rules: readonly string[]): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const rule of rules) {
    const base = ruleKey(rule)
    let key = base
    let n = 2
    while (key in criteria) key = `${base} (${n++})`
    criteria[key] = String(rule)
  }
  criteria[NONE] = "No rule in this list matches the action."
  return criteria
}

/** Splice defaults into a user list, or replace them when the marker is absent. */
function mergeList(defaults: readonly string[], user: string[] | undefined): string[] {
  if (user === undefined) return [...defaults]
  if (!user.includes(DEFAULTS_MARKER)) return [...user]
  return user.flatMap((entry) => (entry === DEFAULTS_MARKER ? [...defaults] : [entry]))
}

/** Merge user rule lists over the built-ins, honoring the `$defaults` marker per section. */
export function mergeRules(user: RuleLists | undefined): Required<RuleLists> {
  return {
    hard_deny: mergeList(DEFAULT_RULES.hard_deny, user?.hard_deny),
    soft_deny: mergeList(DEFAULT_RULES.soft_deny, user?.soft_deny),
    allow: mergeList(DEFAULT_RULES.allow, user?.allow),
    environment: mergeList(DEFAULT_RULES.environment, user?.environment),
  }
}
