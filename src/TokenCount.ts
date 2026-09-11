import type {Usage} from "@agentclientprotocol/sdk";
import type {TokenUsageBreakdown} from "./app-server/v2";

/**
 * Token usage information for a turn.
 * This interface decouples our API from Codex's internal types.
 *
 * [totalTokens]: total number of tokens used (the sum of all other fields)
 * [inputTokens]: number of non-cached input tokens
 * [cachedInputTokens]: number of cached input tokens
 * [outputTokens]: number of output tokens (including reasoning output tokens)
 * [reasoningOutputTokens]: number of reasoning output tokens
 */
export interface TokenCount {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
}

/**
 * Maps Codex's TokenUsageBreakdown to our TokenCount interface.
 * This explicit mapping ensures compile-time errors if Codex changes their types.
 * Note: Codex includes cached input tokens in the input token count, so they are subtracted here.
 */
export function toTokenCount(usage: TokenUsageBreakdown): TokenCount {

    return {
        totalTokens: usage.totalTokens,
        inputTokens: usage.inputTokens - usage.cachedInputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
    };
}

/**
 * Maps our per-turn token breakdown to ACP PromptResponse usage fields.
 * Cached input tokens are reported as ACP cache reads, and reasoning output
 * tokens are exposed through ACP's thoughtTokens field.
 */
export function toPromptUsage(tokenCount: TokenCount): Usage {
    return {
        totalTokens: tokenCount.totalTokens,
        inputTokens: tokenCount.inputTokens,
        cachedReadTokens: tokenCount.cachedInputTokens,
        outputTokens: tokenCount.outputTokens,
        thoughtTokens: tokenCount.reasoningOutputTokens,
    };
}

/** Accumulate a prompt from cumulative counters; the first sample after a cold
 * resume uses its last response, excluding pre-existing session usage. Repeated
 * notifications add nothing. Counter regressions are unknown accounting, not
 * zero cost or permission to invent a new baseline mid-prompt. */
export function addPromptTokenUsage(
    accumulated: TokenCount | null,
    previousTotal: TokenCount | null,
    total: TokenCount,
    last: TokenCount,
): TokenCount | null {
    const result = {...total};
    for (const key of Object.keys(total) as Array<keyof TokenCount>) {
        const increment = previousTotal == null ? last[key] : total[key] - previousTotal[key];
        if (!Number.isFinite(increment) || increment < 0) return null;
        result[key] = (accumulated?.[key] ?? 0) + increment;
    }
    return result;
}
