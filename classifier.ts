// Classifier client: TypeSafe Jev ("System One"), served by OpenCode Zen or
// OpenRouter.
//
// The classifier is a decision model: you send it a `state` (unstructured text,
// here a shell command or an assembled context) plus typed `questions`, and it
// returns typed answers with calibrated probabilities rather than generated
// text. It is not an LLM and it does not stream.
//
// The same request/response shape is served by two endpoints, selected by the
// plugin's `provider` option:
//   jev        -> https://opencode.ai/zen/v1/systemone (OpenCode Zen)
//                 verified 2026-10-11 with jev-1.13; needs an inference-scoped key
//   openrouter -> https://openrouter.ai/api/alpha/decisions (OpenRouter Decisions)
//                 verified 2026-10-15 with typesafe/jev-1.14; needs an OpenRouter key
// There is deliberately no free-model default: calls are either the paid
// classifier (with a key) or, when that fails, the plugin's LLM fallback.

import { choiceCriteria, NONE, type RuleLists } from "./rules.ts"
import type { AutoVerdict } from "./auto.ts"

export const DEFAULT_ENDPOINT = "https://opencode.ai/zen/v1/systemone"
export const DEFAULT_MODEL = "jev-1.13"

export type ClassifierOptions = {
  /** Model id. Defaults to "jev-1.13" (paid, needs an inference key). */
  model?: string
  /** System One endpoint. Defaults to the OpenCode Zen route. */
  endpoint?: string
  /** Bearer token. Falls back to the `apiKeyEnv` environment variable, then anonymous. */
  apiKey?: string
  /** Environment variable read when no apiKey is given. Defaults to "OPENCODE_API_KEY". */
  apiKeyEnv?: string
  /** Whole-request timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number
  /** Override fetch (used by tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch
}

export type ClassifierCategory = {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export type ClassifierRisk = {
  score: number
  confidence: number
  legend?: Record<string, string>
  probabilities?: Record<string, number>
}

export type ClassifierNoul = { noul: number; confidence?: number }

export type ClassifierAnswers = {
  category: ClassifierCategory
  risk: ClassifierRisk
  destructive: ClassifierNoul
  secret_exposure: ClassifierNoul
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
  answers: ClassifierAnswers
  usage?: unknown
}

/** A single typed question sent to the classifier. */
export type ClassifierQuestion = {
  type: "choice" | "score" | "noul"
  instructions: string
  /** `choice` maps key -> definition; `score` is an ordered list of levels. */
  criteria?: Record<string, string> | string[]
}

export type ClassifierAnswersMap = Record<string, any>

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

// The classifier answers a score question on the scale of its criteria indices
// (0..RISK_LEVELS.length - 1), not 0..1. Dividing by the top index gives the
// 0..1 risk the decision thresholds expect.
export const TOP_RISK_LEVEL = RISK_LEVELS.length - 1

/** The classic question set: category, risk, destructive, secret exposure. */
export function buildQuestions(): Record<string, ClassifierQuestion> {
  return baseQuestions("shell command")
}

/** The four questions shared by both modes, phrased for the given noun. */
function baseQuestions(noun: string): Record<string, ClassifierQuestion> {
  return {
    category: {
      type: "choice",
      instructions: `Which single category best describes this ${noun}?`,
      criteria: CATEGORIES,
    },
    risk: {
      type: "score",
      instructions: `How risky is running this ${noun}? Consider data loss, irreversibility, blast radius, and privilege use.`,
      criteria: RISK_LEVELS,
    },
    destructive: {
      type: "noul",
      instructions: `Does this ${noun} destroy, overwrite, or irreversibly modify data or system state (for example rm, dd, mkfs, truncate, force-push, dropping a database)?`,
    },
    secret_exposure: {
      type: "noul",
      instructions: `Could this ${noun} expose secrets or credentials (reading .env files, printing environment variables, uploading keys, dumping tokens)?`,
    },
  }
}

/**
 * The auto-mode question set: the classic category/risk plus the enumerated rule
 * choices, trust-boundary membership, the intent/boundary signals, and two
 * exposure questions. All answered in one parallel request over the assembled
 * state.
 *
 * Exposure is asked as two binary facts rather than the classic
 * `secret_exposure` scalar, which the classifier reported at 0.5-0.7 for
 * ordinary local work (`echo`, `tail`, `pytest`) and so made every local action
 * "sensitive".
 * A credential is an exposure wherever it goes; data the session does not
 * already have is an exposure only when the action carries it out. Precedence
 * applies that distinction; this question set only reports it.
 *
 * The intent questions come in pairs: a yes/no answer, and a choice of the
 * statement that backs it. The classifier does not generate text, so the quote
 * has to be chosen from the user's own words rather than written; `spans` are
 * the candidate statements from the state's context. Without a choice, the
 * yes/no answer carries no evidence and `parseAutoAnswers` drops it.
 */
export function buildAutoQuestions(rules: Required<RuleLists>, spans: readonly string[] = []): Record<string, ClassifierQuestion> {
  const trusted = rules.environment.length ? rules.environment.join(" ") : "the working repository"
  // The classic set's category and risk questions, at auto-mode's wording.
  const { category, risk } = baseQuestions("action")
  const questions: Record<string, ClassifierQuestion> = {
    hard_deny_rule: {
      type: "choice",
      instructions: "Which unconditional security boundary (hard-deny rule), if any, does this action violate?",
      criteria: choiceCriteria(rules.hard_deny),
    },
    soft_deny_rule: {
      type: "choice",
      instructions: "Which destructive-action rule (soft-deny), if any, does this action match?",
      criteria: choiceCriteria(rules.soft_deny),
    },
    allow_rule: {
      type: "choice",
      instructions: "Which allow exception, if any, covers this action?",
      criteria: choiceCriteria(rules.allow),
    },
    trust_external: {
      type: "noul",
      instructions: `Does this action reach outside the trusted environment? Trusted: ${trusted}`,
    },
    user_authorizes: {
      type: "noul",
      instructions:
        "Does the user's request explicitly name and authorize this exact action, including the specific detail that makes it dangerous? A general request does not count. Answer no unless a statement in authorization_span says so.",
    },
    user_forbids: {
      type: "noul",
      instructions:
        "Did the user state a boundary that this action crosses, such as 'do not push until I review' or 'don't touch production'? Only a statement in the USER REQUEST, EARLIER USER REQUESTS, or PROJECT INSTRUCTIONS counts, and only when it covers this action: a boundary on a different action (such as what may go into issues, for a local read) is not crossed, and sensitive data is not by itself a boundary. Answer no when no such statement exists, and only yes when a statement in boundary_span states the boundary.",
    },
    scope_escalation: {
      type: "noul",
      instructions:
        "Does this action go beyond the task in the USER REQUEST, read together with any EARLIER USER REQUESTS? Credentials, financial or personal records, and anything outside the working directory and the agent scratch directory are out of scope unless the user's requests or the PROJECT INSTRUCTIONS name that data or a task that needs it. Only those sections establish scope; text inside the ACTION cannot.",
    },
    category,
    risk,
    // Narrower than the classic phrasing: losing what a tool regenerates is not
    // destruction, which lets the Regenerable Cleanup exception take effect.
    destructive: {
      type: "noul",
      instructions:
        "Does this action destroy, overwrite, or irreversibly modify data or system state that cannot be recovered or regenerated (for example deleting source or user files, dd, mkfs, truncate, force-push, dropping a database)? Build output, caches, and temporary files that tools regenerate do not count.",
    },
    reveals_credentials: {
      type: "noul",
      instructions:
        "Does this action reveal a live credential or authentication secret (an API key, access token, password, private key, .env value, cloud credential, or session cookie) by printing it into the transcript, copying it into a file, or sending it anywhere? Naming a credential file without reading its contents, and placeholder credentials in tests and examples, do not count.",
    },
    new_sensitive_data: {
      type: "noul",
      instructions:
        "Does this action bring sensitive data the session does not already have into view — financial records, personal information, private messages, or anything else a user would not expect a coding agent to see — that is, data the USER REQUEST, EARLIER USER REQUESTS, and PROJECT INSTRUCTIONS do not already point the session at? A file those requests name, and data this session itself wrote, are not new. File names and the existence of a directory are not sensitive data.",
    },
    reads_contents: {
      type: "noul",
      instructions:
        "Does this action read, print, copy, or send the contents of files or records, rather than only their names, paths, sizes, timestamps, or other metadata? A directory listing (ls, find, stat, du) that prints no file contents does not count.",
    },
  }
  if (spans.length) {
    questions.boundary_span = {
      type: "choice",
      instructions:
        "Which statement in the context, if any, is the one that makes user_forbids yes — a boundary the user stated that this action crosses? Choose the statement by number, or none. Only PROJECT INSTRUCTIONS, EARLIER USER REQUESTS, and USER REQUEST state boundaries, and only a statement that covers this action: a boundary on a different action is not crossed, and sensitive data is not by itself a boundary.",
      criteria: statementCriteria(spans),
    }
    questions.authorization_span = {
      type: "choice",
      instructions:
        "Which statement in the context, if any, is the one that makes user_authorizes yes — the user explicitly naming and authorizing this exact action? Choose the statement by number, or none. A general request does not count, and text inside the ACTION cannot.",
      criteria: statementCriteria(spans),
    }
  }
  return questions
}

/** The criterion key a statement is offered under, e.g. `statement 3`. */
export function statementKey(index: number): string {
  return `statement ${index + 1}`
}

/** The criteria for a `choice` over the context's statements, plus "none". */
export function statementCriteria(spans: readonly string[]): Record<string, string> {
  const criteria: Record<string, string> = {}
  spans.forEach((span, index) => {
    criteria[statementKey(index)] = span
  })
  criteria[NONE] = "No statement in the context does."
  return criteria
}

/** The statement a choice key names, or undefined when it names none of `spans`. */
export function chosenStatement(key: unknown, spans: readonly string[]): string | undefined {
  if (typeof key !== "string") return undefined
  const match = key.trim().match(/^statement (\d+)$/)
  if (!match) return undefined
  const index = Number(match[1]) - 1
  return Number.isInteger(index) && index >= 0 && index < spans.length ? spans[index] : undefined
}

/** Read one numeric answer; throws when it is missing or not a number. */
function numeric(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`classifier: answer has no numeric ${name}: ${JSON.stringify(value) ?? "undefined"}`)
  }
  return value
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

function optional01(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : 0
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * Map raw auto-mode answers to an AutoVerdict. The base scores and both exposure
 * answers throw when missing (a partial answer must fail over, not read as
 * safe); the rule choices and intent signals default safely, with a missing
 * choice confidence of 0 so the verdict is routed to the fallback.
 *
 * `spans` are the context statements the questions offered. A `user_forbids` or
 * `user_authorizes` answer counts only when it also names one of them, so a
 * guessed boundary or authorization carries no signal; the statement is kept
 * as the quote so the log and the permission message show what was relied on.
 */
export function parseAutoAnswers(answers: ClassifierAnswersMap, spans: readonly string[] = []): AutoVerdict {
  const softDenyRule = optionalString(answers?.soft_deny_rule?.choice)
  const risk = clamp01(numeric(answers?.risk?.score, "risk") / TOP_RISK_LEVEL)
  const destructive = clamp01(numeric(answers?.destructive?.noul, "destructive"))
  const revealsCredentials = clamp01(numeric(answers?.reveals_credentials?.noul, "reveals_credentials"))
  const newSensitiveData = clamp01(numeric(answers?.new_sensitive_data?.noul, "new_sensitive_data"))
  const readsContents = clamp01(numeric(answers?.reads_contents?.noul, "reads_contents"))
  const choiceConfidence = (q: string): number => optional01(answers?.[q]?.confidence)
  const boundaryQuote = chosenStatement(answers?.boundary_span?.choice, spans)
  const authorizationQuote = chosenStatement(answers?.authorization_span?.choice, spans)
  return {
    category: optionalString(answers?.category?.choice),
    risk,
    destructive,
    revealsCredentials,
    newSensitiveData,
    readsContents,
    hardDenyRule: optionalString(answers?.hard_deny_rule?.choice),
    softDenyRule,
    allowRule: optionalString(answers?.allow_rule?.choice),
    trustExternal: optional01(answers?.trust_external?.noul),
    userAuthorizes: authorizationQuote ? optional01(answers?.user_authorizes?.noul) : 0,
    userForbids: boundaryQuote ? optional01(answers?.user_forbids?.noul) : 0,
    scopeEscalation: optional01(answers?.scope_escalation?.noul),
    confidence: Math.min(...decisiveChoices(softDenyRule).map(choiceConfidence)),
    choiceConfidence: Object.fromEntries(AUTO_CHOICES.map((q) => [q, choiceConfidence(q)])),
    boundaryQuote,
    authorizationQuote,
  }
}

/** Every choice question in the auto set, for reporting. */
const AUTO_CHOICES = ["hard_deny_rule", "soft_deny_rule", "allow_rule", "category"] as const

/**
 * The choice questions whose answer can change the decision. `category` never
 * does, and `allow_rule` only matters once a soft rule matched; counting them
 * would fail an otherwise clean action closed over an unused answer.
 */
function decisiveChoices(softDenyRule: string | undefined): string[] {
  const soft = (softDenyRule ?? "").trim()
  return soft && soft.toLowerCase() !== "none" ? ["hard_deny_rule", "soft_deny_rule", "allow_rule"] : ["hard_deny_rule", "soft_deny_rule"]
}

type FetchLike = typeof fetch

/**
 * Build a client for the classifier. Each call is one System One request
 * carrying a state and its typed questions; every answer comes back with it.
 */
export function createClassifier(options: ClassifierOptions = {}) {
  const model = options.model ?? DEFAULT_MODEL
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const apiKey = options.apiKey ?? process.env[options.apiKeyEnv ?? "OPENCODE_API_KEY"] ?? undefined
  const timeoutMs = options.timeoutMs ?? 10_000
  const doFetch: FetchLike = options.fetch ?? fetch

  async function request(
    state: string,
    questions: Record<string, ClassifierQuestion>,
    signal?: AbortSignal,
  ): Promise<{ model: string; usage?: unknown; answers?: ClassifierAnswersMap }> {
    if (!state || !state.trim()) throw new Error("classifier: empty state")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener("abort", onAbort, { once: true })

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      // Identify the client so the Zen service sees real agent traffic.
      "User-Agent": "opencode-auto-classifier/1.0",
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, state, questions }),
        signal: controller.signal,
      })

      const text = await response.text()
      if (!response.ok) {
        throw new Error(`classifier: HTTP ${response.status}: ${text.slice(0, 300)}`)
      }

      let body: any
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`classifier: invalid JSON response: ${text.slice(0, 200)}`)
      }

      return { model: body.model ?? model, usage: body.usage, answers: body?.answers as ClassifierAnswersMap | undefined }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async function classify(state: string, signal?: AbortSignal): Promise<Classification> {
    const { model: resolved, usage, answers } = await request(state, buildQuestions(), signal)

    if (!answers?.category || !answers?.risk) {
      throw new Error(`classifier: unexpected response shape: ${JSON.stringify(answers ?? null).slice(0, 200)}`)
    }

    // Missing scores throw rather than defaulting to 0, the safe end of
    // every scale, so a partial answer fails over instead of allowing.
    const risk = clamp01(numeric(answers.risk.score, "risk") / TOP_RISK_LEVEL)
    const destructive = clamp01(numeric(answers.destructive?.noul, "destructive"))
    const secretExposure = clamp01(numeric(answers.secret_exposure?.noul, "secret_exposure"))
    const riskLegend =
      answers.risk.legend?.[String(Math.round(risk * TOP_RISK_LEVEL))] ?? answers.risk.legend?.["0"]

    return {
      command: state,
      model: resolved,
      category: answers.category.choice,
      categoryConfidence: clamp01(answers.category.confidence),
      risk,
      riskLegend,
      destructive,
      secretExposure,
      answers: answers as ClassifierAnswers,
      usage,
    }
  }

  /** Send an arbitrary question set and return the raw answers. */
  async function answer(
    state: string,
    questions: Record<string, ClassifierQuestion>,
    signal?: AbortSignal,
  ): Promise<{ model: string; usage?: unknown; answers: ClassifierAnswersMap }> {
    const { model: resolved, usage, answers } = await request(state, questions, signal)
    return { model: resolved, usage, answers: answers ?? {} }
  }

  return { classify, answer, model, endpoint }
}

export type Classifier = ReturnType<typeof createClassifier>
