// TypeSafe Jev ("System One") client for the OpenCode Zen endpoint.
//
// Jev is a decision model: you send it a `state` (unstructured text, here a
// shell command) plus typed `questions`, and it returns typed answers with
// calibrated probabilities rather than generated text. It is not an LLM and it
// does not stream.
//
// Verified against https://opencode.ai/zen/v1/systemone on 2026-10-11:
//   jev-1.13       -> requires Authorization: Bearer <inference-scoped key>
// There is deliberately no free-model default: calls are either the paid Jev
// model (with a key) or, when that fails, the plugin's LLM fallback.

export const DEFAULT_ENDPOINT = "https://opencode.ai/zen/v1/systemone"
export const DEFAULT_MODEL = "jev-1.13"

export type JevOptions = {
  /** Model id. Defaults to "jev-1.13" (paid, needs an inference key). */
  model?: string
  /** System One endpoint. Defaults to the OpenCode Zen route. */
  endpoint?: string
  /** Bearer token. Falls back to OPENCODE_API_KEY, then anonymous. */
  apiKey?: string
  /** Whole-request timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number
  /** Override fetch (used by tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch
}

export type JevCategory = {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export type JevRisk = {
  score: number
  confidence: number
  legend?: Record<string, string>
  probabilities?: Record<string, number>
}

export type JevNoul = { noul: number; confidence?: number }

export type JevAnswers = {
  category: JevCategory
  risk: JevRisk
  destructive: JevNoul
  secret_exposure: JevNoul
}

export type Classification = {
  command: string
  model: string
  /** One of the category criteria keys. */
  category: string
  categoryConfidence: number
  /** 0..1, where 1 means maximally risky. */
  risk: number
  riskLegend?: string
  /** 0..1 probability the command destroys data or system state. */
  destructive: number
  /** 0..1 probability the command leaks secrets or credentials. */
  secretExposure: number
  answers: JevAnswers
  usage?: unknown
}

const CATEGORIES: Record<string, string> = {
  read: "Reads or inspects files, directories, processes, or state without changing anything",
  write: "Creates, modifies, moves, renames, or deletes files or data",
  vcs: "Git or other version-control operations (status, diff, commit, push, ...)",
  build: "Installs dependencies, compiles, builds, packages, or runs tests",
  network: "Sends or receives data over the network (curl, wget, ssh, package fetches)",
  process: "Starts, stops, or manages processes, services, containers, or schedulers",
  privileged: "Escalates privileges or changes permissions/ownership (sudo, chmod, chown)",
  other: "Anything that does not fit the other categories",
}

const RISK_LEVELS = [
  "Safe: read-only or trivially reversible",
  "Low: local, reversible, no data loss",
  "Moderate: changes files or system state",
  "High: risky, wide blast radius, or hard to undo",
  "Critical: destructive or irreversible (data loss, system damage)",
]

function buildQuestions() {
  return {
    category: {
      type: "choice",
      instructions: "Which single category best describes this shell command?",
      criteria: CATEGORIES,
    },
    risk: {
      type: "score",
      instructions:
        "How risky is running this shell command? Consider data loss, irreversibility, blast radius, and privilege use.",
      criteria: RISK_LEVELS,
    },
    destructive: {
      type: "noul",
      instructions:
        "Does this command destroy, overwrite, or irreversibly modify data or system state (for example rm, dd, mkfs, truncate, force-push, dropping a database)?",
    },
    secret_exposure: {
      type: "noul",
      instructions:
        "Could this command expose secrets or credentials (reading .env files, printing environment variables, uploading keys, dumping tokens)?",
    },
  }
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

type FetchLike = typeof fetch

/**
 * Build a classifier that sends shell commands to Jev and returns structured
 * risk decisions. Each call is a single System One request; all questions are
 * answered in parallel by the model.
 */
export function createClassifier(options: JevOptions = {}) {
  const model = options.model ?? DEFAULT_MODEL
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const apiKey = options.apiKey ?? process.env.OPENCODE_API_KEY ?? undefined
  const timeoutMs = options.timeoutMs ?? 10_000
  const doFetch: FetchLike = options.fetch ?? fetch

  async function classify(state: string, signal?: AbortSignal): Promise<Classification> {
    if (!state || !state.trim()) throw new Error("jev: empty state")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener("abort", onAbort, { once: true })

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      // Identify the client so the Zen service sees real agent traffic.
      "User-Agent": "opencode-jev-classifier/1.0",
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, state, questions: buildQuestions() }),
        signal: controller.signal,
      })

      const text = await response.text()
      if (!response.ok) {
        throw new Error(`jev: HTTP ${response.status}: ${text.slice(0, 300)}`)
      }

      let body: any
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`jev: invalid JSON response: ${text.slice(0, 200)}`)
      }

      const answers = body?.answers as JevAnswers | undefined
      if (!answers?.category || !answers?.risk) {
        throw new Error(`jev: unexpected response shape: ${text.slice(0, 200)}`)
      }

      const riskLegend =
        answers.risk.legend?.[String(Math.round(clamp01(answers.risk.score) * 4))] ??
        answers.risk.legend?.["0"]

      return {
        command: state,
        model: body.model ?? model,
        category: answers.category.choice,
        categoryConfidence: clamp01(answers.category.confidence),
        risk: clamp01(answers.risk.score),
        riskLegend,
        destructive: clamp01(answers.destructive?.noul),
        secretExposure: clamp01(answers.secret_exposure?.noul),
        answers,
        usage: body.usage,
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  return { classify, model, endpoint }
}

export type Classifier = ReturnType<typeof createClassifier>
