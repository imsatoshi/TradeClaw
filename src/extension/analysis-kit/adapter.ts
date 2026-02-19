import type { Sandbox } from './sandbox/Sandbox';
import { createAnalysisToolsImpl } from './adapters/analysis';

/**
 * Create analysis AI tools (observation only)
 *
 * - Market data: getLatestOHLCV, getAllowedSymbols
 * - News: globNews, grepNews, readNews
 * - Time: getCurrentTime
 * - Thinking: think, plan
 * - Calculation: calculate, calculateIndicator
 * - Utility: reportWarning, getConfirm
 *
 * NOTE: Cognition tools (frontal lobe, emotion) moved to extension/brain
 */
export function createAnalysisTools(sandbox: Sandbox) {
  return {
    ...createAnalysisToolsImpl(sandbox),
  };
}
