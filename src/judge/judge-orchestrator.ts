import type { TopicSession, TopicMessage } from "../domain/session-types.js"
import type { ProviderProfile } from "../config/config-types.js"
import type { JudgeOption, JudgeAdvocateResult, JudgeDecision } from "./judge-types.js"
import { extractJudgeOptions } from "./judge-extraction.js"
import { runClaudeExtraction } from "../claude-extract.js"
import { loggers } from "../logger.js"
import {
  formatJudgeExtraction,
  formatJudgeArena,
  formatAdvocateArgument,
  formatJudgeVerdict,
  formatJudgeError,
} from "../telegram/format.js"
import type { EngineContext } from "../engine/engine-context.js"

const log = loggers.judgeOrchestrator

const ADVOCATE_TIMEOUT_MS = 180_000
const JUDGE_TIMEOUT_MS = 180_000

const ADVOCATE_SYSTEM_PROMPT = [
  "You are a technical advocate in a design decision arena.",
  "Your job is to research and argue FOR the assigned design option.",
  "",
  "You will be given:",
  "1. The original conversation context",
  "2. The specific option you must advocate for",
  "3. All other options being considered",
  "",
  "Instructions:",
  "- Research the option thoroughly using web searches to find current best practices, benchmarks, and real-world examples.",
  "- Build a compelling case FOR this option with concrete evidence.",
  "- Acknowledge weaknesses honestly but explain mitigations.",
  "- Compare against the other options where relevant.",
  "- Cite sources when possible.",
  "",
  "Output ONLY a JSON object with no surrounding text or markdown fencing:",
  '{',
  '  "argument": "your detailed argument for this option (500-1000 chars)",',
  '  "sources": ["url or reference 1", "url or reference 2"],',
  '  "searchCount": 3',
  '}',
].join("\n")

const JUDGE_SYSTEM_PROMPT = [
  "You are the final judge in a design decision arena.",
  "You have received arguments from advocates for each design option.",
  "",
  "Your job is to:",
  "1. Evaluate all arguments objectively",
  "2. Consider the original context and constraints",
  "3. Pick the best option with clear reasoning",
  "4. Identify key tradeoffs",
  "",
  "Be decisive — you must pick exactly one winner.",
  "Base your decision on the strength of evidence, not just rhetoric.",
  "",
  "Output ONLY a JSON object with no surrounding text or markdown fencing:",
  '{',
  '  "chosenOptionId": "the-winning-option-id",',
  '  "reasoning": "detailed explanation of why this option won (300-800 chars)",',
  '  "summary": "one-sentence summary of the decision",',
  '  "tradeoffs": ["tradeoff 1", "tradeoff 2"]',
  '}',
].join("\n")

interface AdvocateOutput {
  argument: string
  sources: string[]
  searchCount: number
}

export interface JudgeArenaResult {
  decision?: JudgeDecision
  options?: JudgeOption[]
  advocateResults?: JudgeAdvocateResult[]
  error?: string
}

export class JudgeOrchestrator {
  private readonly ctx: EngineContext

  constructor(ctx: EngineContext) {
    this.ctx = ctx
  }

  async handleJudgeCommand(topicSession: TopicSession, directive?: string): Promise<void> {
    const { slug, threadId, conversation } = topicSession

    // Kill any active session in this topic
    if (topicSession.activeSessionId) {
      const activeSession = this.ctx.sessions.get(threadId)
      if (activeSession) await activeSession.handle.kill()
      this.ctx.sessions.delete(threadId)
      topicSession.activeSessionId = undefined
    }

    // Send extraction status
    await this.ctx.postStatus(topicSession, formatJudgeExtraction(slug))

    // Resolve provider profile
    const profile = topicSession.profileId
      ? this.ctx.profileStore.get(topicSession.profileId)
      : undefined

    // Extract options from conversation
    const extractResult = await extractJudgeOptions(conversation, directive, profile)

    if (extractResult.error) {
      log.warn({ slug, error: extractResult.error, message: extractResult.errorMessage }, "option extraction failed")
      await this.ctx.postStatus(topicSession, formatJudgeError(slug, extractResult.errorMessage ?? "Failed to extract options"))
      return
    }

    if (extractResult.options.length < 2) {
      await this.ctx.postStatus(topicSession, formatJudgeError(slug, "Could not identify at least 2 distinct design options from the conversation. Try providing more context or a directive."))
      return
    }

    const options = extractResult.options
    const question = directive ?? summarizeQuestion(conversation)

    // Show arena with options
    await this.ctx.postStatus(topicSession, formatJudgeArena(slug, question, options))

    // Spawn advocates in parallel
    log.info({ slug, optionCount: options.length }, "spawning advocates")
    const advocateResults = await this.runAdvocates(options, conversation, question, profile)

    // Post advocate arguments to Telegram
    for (const result of advocateResults) {
      const option = options.find((o) => o.id === result.optionId)
      if (!option) continue
      await this.ctx.postStatus(topicSession, formatAdvocateArgument(result.optionId, option.title, result.argument, result.sources.length))
    }

    if (advocateResults.length === 0) {
      log.warn({ slug }, "all advocates failed")
      await this.ctx.postStatus(topicSession, formatJudgeError(slug, "All advocate agents failed to produce arguments. Try again."))
      return
    }

    // Run final judge
    log.info({ slug, advocateCount: advocateResults.length }, "running final judge")
    const decision = await this.runJudge(options, advocateResults, conversation, question, profile)

    if (!decision) {
      log.warn({ slug }, "judge failed to produce verdict")
      await this.ctx.postStatus(topicSession, formatJudgeError(slug, "Judge agent failed to produce a verdict. Try again."))
      return
    }

    // Find chosen option title
    const chosenOption = options.find((o) => o.id === decision.chosenOptionId)
    const chosenTitle = chosenOption?.title ?? decision.chosenOptionId

    // Post verdict
    await this.ctx.postStatus(topicSession, formatJudgeVerdict(question, decision.chosenOptionId, chosenTitle, decision.reasoning))

    // Add verdict to conversation so the planning agent has it
    this.ctx.pushToConversation(topicSession, {
      role: "assistant",
      text: [
        `Judge Arena Verdict: ${decision.summary}`,
        `Chosen: ${decision.chosenOptionId} — ${chosenTitle}`,
        `Reasoning: ${decision.reasoning}`,
        decision.tradeoffs.length > 0
          ? `Tradeoffs: ${decision.tradeoffs.join("; ")}`
          : "",
      ].filter(Boolean).join("\n"),
    })

    log.info({ slug, chosenOptionId: decision.chosenOptionId }, "judge arena complete")
  }

  async tryJudgeArena(topicSession: TopicSession, directive?: string): Promise<boolean> {
    const { slug, conversation } = topicSession

    const profile = topicSession.profileId
      ? this.ctx.profileStore.get(topicSession.profileId)
      : undefined

    const extractResult = await extractJudgeOptions(conversation, directive, profile)

    if (extractResult.error || extractResult.options.length < 2) {
      log.info({ slug, optionCount: extractResult.options.length }, "judge arena skipped — insufficient options")
      return false
    }

    const options = extractResult.options
    const question = directive ?? summarizeQuestion(conversation)

    await this.ctx.postStatus(topicSession, formatJudgeArena(slug, question, options))

    log.info({ slug, optionCount: options.length }, "spawning advocates")
    const advocateResults = await this.runAdvocates(options, conversation, question, profile)

    for (const result of advocateResults) {
      const option = options.find((o) => o.id === result.optionId)
      if (!option) continue
      await this.ctx.postStatus(topicSession, formatAdvocateArgument(result.optionId, option.title, result.argument, result.sources.length))
    }

    if (advocateResults.length === 0) {
      log.warn({ slug }, "all advocates failed in ship judge arena")
      return false
    }

    log.info({ slug, advocateCount: advocateResults.length }, "running final judge")
    const decision = await this.runJudge(options, advocateResults, conversation, question, profile)

    if (!decision) {
      log.warn({ slug }, "judge failed in ship judge arena")
      return false
    }

    const chosenOption = options.find((o) => o.id === decision.chosenOptionId)
    const chosenTitle = chosenOption?.title ?? decision.chosenOptionId

    await this.ctx.postStatus(topicSession, formatJudgeVerdict(question, decision.chosenOptionId, chosenTitle, decision.reasoning))

    this.ctx.pushToConversation(topicSession, {
      role: "assistant",
      text: [
        `Judge Arena Verdict: ${decision.summary}`,
        `Chosen: ${decision.chosenOptionId} — ${chosenTitle}`,
        `Reasoning: ${decision.reasoning}`,
        decision.tradeoffs.length > 0
          ? `Tradeoffs: ${decision.tradeoffs.join("; ")}`
          : "",
      ].filter(Boolean).join("\n"),
    })

    log.info({ slug, chosenOptionId: decision.chosenOptionId }, "ship judge arena complete")
    return true
  }

  private async runAdvocates(
    options: JudgeOption[],
    conversation: TopicMessage[],
    question: string,
    profile?: ProviderProfile,
  ): Promise<JudgeAdvocateResult[]> {
    const conversationSummary = buildConversationSummary(conversation)

    const tasks = options.map((option) => {
      const otherOptions = options.filter((o) => o.id !== option.id)
      const task = [
        "## Context",
        conversationSummary,
        "",
        `## Question: ${question}`,
        "",
        `## Your assigned option: ${option.id}`,
        `**${option.title}**: ${option.description}`,
        "",
        "## Other options being considered:",
        ...otherOptions.map((o) => `- **${o.id}** — ${o.title}: ${o.description}`),
        "",
        "Research this option using web searches and build a compelling case FOR it.",
      ].join("\n")

      return runAdvocateAgent(task, option.id, profile)
    })

    const results = await Promise.allSettled(tasks)
    const advocateResults: JudgeAdvocateResult[] = []

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const option = options[i]

      if (result.status === "fulfilled" && result.value) {
        advocateResults.push({
          optionId: option.id,
          role: "for",
          argument: result.value.argument,
          sources: result.value.sources,
        })
      } else {
        const reason = result.status === "rejected" ? result.reason : "empty response"
        log.warn({ optionId: option.id, error: String(reason) }, "advocate failed")
      }
    }

    return advocateResults
  }

  private async runJudge(
    options: JudgeOption[],
    advocateResults: JudgeAdvocateResult[],
    conversation: TopicMessage[],
    question: string,
    profile?: ProviderProfile,
  ): Promise<JudgeDecision | null> {
    const conversationSummary = buildConversationSummary(conversation)

    const task = [
      "## Context",
      conversationSummary,
      "",
      `## Question: ${question}`,
      "",
      "## Options and Advocate Arguments",
      ...options.map((option) => {
        const advocate = advocateResults.find((a) => a.optionId === option.id)
        const argText = advocate
          ? advocate.argument
          : "(no advocate argument available)"
        const sourceText = advocate && advocate.sources.length > 0
          ? `Sources: ${advocate.sources.join(", ")}`
          : ""
        return [
          `### ${option.id} — ${option.title}`,
          `Description: ${option.description}`,
          `Advocate argument: ${argText}`,
          sourceText,
          "",
        ].filter(Boolean).join("\n")
      }),
      "",
      "Evaluate all arguments and pick the best option. Be decisive.",
    ].join("\n")

    try {
      const output = await runClaudeExtraction(task, JUDGE_SYSTEM_PROMPT, {
        timeoutMs: JUDGE_TIMEOUT_MS,
        profile,
        log,
      })

      return parseJudgeDecision(output)
    } catch (err) {
      log.error({ err }, "judge agent failed")
      return null
    }
  }
}

async function runAdvocateAgent(
  task: string,
  optionId: string,
  profile?: ProviderProfile,
): Promise<AdvocateOutput | null> {
  try {
    const output = await runClaudeExtraction(task, ADVOCATE_SYSTEM_PROMPT, {
      timeoutMs: ADVOCATE_TIMEOUT_MS,
      profile,
      log,
    })

    return parseAdvocateOutput(output, optionId)
  } catch (err) {
    log.error({ optionId, err }, "advocate agent threw")
    return null
  }
}

export function parseAdvocateOutput(output: string, optionId: string): AdvocateOutput | null {
  let text = output.trim()

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const objMatch = text.match(/\{[\s\S]*\}/)
  if (!objMatch) {
    log.debug({ optionId }, "no JSON object in advocate output")
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(objMatch[0])
  } catch {
    log.debug({ optionId }, "JSON parse error in advocate output")
    return null
  }

  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const argument = typeof obj.argument === "string" && obj.argument.length > 0
    ? obj.argument
    : null

  if (!argument) {
    log.debug({ optionId }, "advocate output missing argument field")
    return null
  }

  const sources = Array.isArray(obj.sources)
    ? obj.sources.filter((s): s is string => typeof s === "string")
    : []

  const searchCount = typeof obj.searchCount === "number" ? obj.searchCount : sources.length

  return { argument, sources, searchCount }
}

export function parseJudgeDecision(output: string): JudgeDecision | null {
  let text = output.trim()

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const objMatch = text.match(/\{[\s\S]*\}/)
  if (!objMatch) {
    log.debug("no JSON object in judge output")
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(objMatch[0])
  } catch {
    log.debug("JSON parse error in judge output")
    return null
  }

  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const chosenOptionId = typeof obj.chosenOptionId === "string" && obj.chosenOptionId.length > 0
    ? obj.chosenOptionId
    : null
  const reasoning = typeof obj.reasoning === "string" && obj.reasoning.length > 0
    ? obj.reasoning
    : null
  const summary = typeof obj.summary === "string" && obj.summary.length > 0
    ? obj.summary
    : "Decision made by judge arena"

  if (!chosenOptionId || !reasoning) {
    log.debug("judge output missing required fields")
    return null
  }

  const tradeoffs = Array.isArray(obj.tradeoffs)
    ? obj.tradeoffs.filter((t): t is string => typeof t === "string")
    : []

  return { chosenOptionId, reasoning, summary, tradeoffs }
}

function summarizeQuestion(conversation: TopicMessage[]): string {
  const lastUserMessage = [...conversation].reverse().find((m) => m.role === "user")
  if (lastUserMessage) {
    const text = lastUserMessage.text.trim()
    return text.length > 200 ? text.slice(0, 200) + "…" : text
  }
  return "Design decision"
}

function buildConversationSummary(conversation: TopicMessage[]): string {
  const MAX_CHARS = 3000
  const lines: string[] = []
  let totalChars = 0

  for (const msg of conversation) {
    const label = msg.role === "user" ? "User" : "Agent"
    const text = msg.text.length > 500 ? msg.text.slice(-500) : msg.text
    const line = `${label}: ${text}`
    if (totalChars + line.length > MAX_CHARS) break
    lines.push(line)
    totalChars += line.length
  }

  return lines.join("\n\n")
}
