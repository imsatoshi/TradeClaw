/**
 * DeepSeek safety guards — hallucination detection, tool refusal detection,
 * and tool result formatting.
 *
 * These guards exist because DeepSeek models sometimes:
 * 1. Claim to execute trading actions without calling any tools (hallucination)
 * 2. Give up after tool failures, suggesting manual alternatives (refusal)
 * 3. Generate terse responses after tool calls, requiring manual formatting
 *
 * Claude Code provider does NOT need these guards — Claude is reliable enough.
 * Guards are applied only in the VercelAIProvider path.
 */

// ==================== Trading Hallucination Guard ====================

/**
 * Detect when the model claims to have executed a trading action but made
 * zero tool calls — a hallucination that pollutes session history.
 */
export const TRADING_CLAIM_RE = /已设置|已提交|订单已|已下单|已挂单|已修改|已取消|已撤单|已平仓|已止盈|已止损|已开仓|order placed|order modified|order cancel|position closed/i

export function isTradingHallucination(text: string, toolCallCount: number): boolean {
  return toolCallCount === 0 && TRADING_CLAIM_RE.test(text)
}

export const HALLUCINATION_CORRECTION = [
  'SYSTEM CORRECTION: Your previous response claimed to execute a trading action without calling any tools.',
  'This is NOT allowed. You MUST call the actual trading tools (cryptoClosePosition, cryptoPlaceOrder, etc.) to execute orders.',
  'Please try again — call the correct tools NOW to fulfill the user\'s request.',
].join(' ')

// ==================== Tool Refusal Guard ====================

/**
 * Detect when the model gives up after a tool failure — claiming "compatibility issues",
 * suggesting manual alternatives, etc. This prevents session pollution where the model
 * "learns" from its own refusal text in subsequent turns.
 */
export const TOOL_REFUSAL_RE = /无法执行|兼容性问题|替代方案|手动操作|系统无法|不支持该操作|cannot execute|compatibility issue|alternative approach|manual operation|unable to perform|not supported/i

export function isToolRefusal(text: string, toolCallCount: number): boolean {
  return toolCallCount > 0 && TOOL_REFUSAL_RE.test(text)
}

export const REFUSAL_CORRECTION = [
  'SYSTEM CORRECTION: The tool failure you encountered was TEMPORARY.',
  'Do NOT suggest manual alternatives or claim the system cannot execute.',
  'You MUST retry the operation NOW using the correct tools.',
  'If the tool failed, try again — transient errors are normal.',
].join(' ')

// ==================== Tool Result Formatter ====================

/**
 * Format specific crypto tool results into human-readable text.
 * Used as a fallback when the model generates terse responses after tool calls.
 */
export function formatToolResults(toolResults: any[]): string | null {
  for (const tr of toolResults) {
    // Format cryptoGetPositions
    if (tr.toolName === 'cryptoGetPositions' && Array.isArray(tr.output) && tr.output.length > 0) {
      const positions = tr.output
      let text = '## 📊 您的持仓情况\n\n'
      text += `**持仓数量:** ${positions.length}\n\n`

      let totalPnl = 0
      positions.forEach((p: any, i: number) => {
        // NFI strategy context header
        const nfiParts: string[] = []
        if (p.enterTag) nfiParts.push(`signal: ${p.enterTag}`)
        if (typeof p.grindCount === 'number' && p.grindCount > 0) nfiParts.push(`DCA: ${p.grindCount}x`)
        if (typeof p.partialExitCount === 'number' && p.partialExitCount > 0) nfiParts.push(`partial exits: ${p.partialExitCount}`)
        const nfiLabel = nfiParts.length > 0 ? ` [NFI ${nfiParts.join(', ')}]` : ''

        text += `**${i + 1}. ${p.symbol}**${nfiLabel}\n`
        text += `- 方向: ${p.side === 'long' ? '做多 📈' : '做空 📉'}\n`
        text += `- 数量: ${p.size}\n`
        text += `- 开仓价: $${p.entryPrice}\n`
        text += `- 标记价: $${typeof p.markPrice === 'number' ? p.markPrice.toFixed(2) : p.markPrice}\n`
        text += `- 杠杆: ${p.leverage}x\n`
        text += `- 未实现盈亏: $${typeof p.unrealizedPnL === 'number' ? p.unrealizedPnL.toFixed(2) : p.unrealizedPnL}`
        if (typeof p.profitRatio === 'number') text += ` (${(p.profitRatio * 100).toFixed(2)}%)`
        text += '\n'
        text += `- 仓位价值: $${typeof p.positionValue === 'number' ? p.positionValue.toFixed(2) : p.positionValue}\n`
        if (p.percentageOfEquity) text += `- 占权益: ${p.percentageOfEquity}\n`
        text += '\n'
        totalPnl += typeof p.unrealizedPnL === 'number' ? p.unrealizedPnL : 0
      })

      text += `**总未实现盈亏:** $${totalPnl.toFixed(2)}\n`
      return text
    }

    // Format cryptoGetAccount
    if (tr.toolName === 'cryptoGetAccount' && tr.output && typeof tr.output === 'object') {
      const a = tr.output
      let text = '## 💰 账户信息\n\n'
      text += `- **可用余额:** $${typeof a.balance === 'number' ? a.balance.toFixed(2) : a.balance}\n`
      text += `- **账户权益:** $${typeof a.equity === 'number' ? a.equity.toFixed(2) : a.equity}\n`
      text += `- **保证金占用:** $${typeof a.totalMargin === 'number' ? a.totalMargin.toFixed(2) : a.totalMargin}\n`
      text += `- **未实现盈亏:** $${typeof a.unrealizedPnL === 'number' ? a.unrealizedPnL.toFixed(2) : a.unrealizedPnL}\n`
      return text
    }
  }
  return null
}
