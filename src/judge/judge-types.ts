/** A design option extracted from the conversation for the judge arena to evaluate. */
export interface JudgeOption {
  id: string
  title: string
  description: string
}

/** The result of an advocate agent arguing for or against an option. */
export interface JudgeAdvocateResult {
  optionId: string
  role: "for" | "against"
  argument: string
  sources: string[]
}

/** The final verdict from the judge agent after reviewing all advocate arguments. */
export interface JudgeDecision {
  chosenOptionId: string
  reasoning: string
  summary: string
  tradeoffs: string[]
}

/** Result of extracting judge options from a conversation. */
export interface JudgeExtractResult {
  options: JudgeOption[]
  error?: "system" | "parse"
  errorMessage?: string
}
