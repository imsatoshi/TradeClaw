import { describe, it, expect } from 'vitest'
import { formatForTelegram } from '../format.js'

describe('formatForTelegram', () => {
  it('escapes HTML entities', () => {
    expect(formatForTelegram('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })

  it('converts bold', () => {
    expect(formatForTelegram('**hello**')).toBe('<b>hello</b>')
  })

  it('converts headings', () => {
    expect(formatForTelegram('## Title')).toBe('<b>Title</b>')
  })

  it('converts inline code', () => {
    expect(formatForTelegram('use `npm install`')).toBe('use <code>npm install</code>')
  })

  it('converts code blocks', () => {
    expect(formatForTelegram('```\ncode\n```')).toBe('<pre>\ncode\n</pre>')
  })

  it('converts 2-column table to key-value list', () => {
    const input = [
      '| 项目 | 数值 |',
      '|------|------|',
      '| 总权益 | $10,000 |',
      '| 余额 | $5,000 |',
    ].join('\n')

    const result = formatForTelegram(input)
    expect(result).toBe([
      '  总权益: $10,000',
      '  余额: $5,000',
    ].join('\n'))
    // No pipe characters remaining
    expect(result).not.toContain('|')
  })

  it('converts 3+ column table to <pre> block', () => {
    const input = [
      '| 币种 | 方向 | 得分 |',
      '|------|------|------|',
      '| BTC | 多 | 65 |',
      '| ETH | 空 | 50 |',
    ].join('\n')

    const result = formatForTelegram(input)
    expect(result).toContain('<pre>')
    expect(result).toContain('</pre>')
    expect(result).toContain('BTC')
    expect(result).toContain('ETH')
    // No pipe characters
    expect(result).not.toContain('|')
  })

  it('preserves non-table text around tables', () => {
    const input = [
      '## Report',
      '',
      '| Key | Val |',
      '|-----|-----|',
      '| A | 1 |',
      '',
      'Done.',
    ].join('\n')

    const result = formatForTelegram(input)
    expect(result).toContain('<b>Report</b>')
    expect(result).toContain('A: 1')
    expect(result).toContain('Done.')
  })

  it('handles table with no separator row', () => {
    const input = [
      '| A | B |',
      '| 1 | 2 |',
    ].join('\n')

    const result = formatForTelegram(input)
    // Should still convert — first row as header, second as data
    expect(result).not.toContain('|')
  })

  it('handles empty cells gracefully', () => {
    const input = [
      '| Name | Value |',
      '|------|-------|',
      '| X |  |',
    ].join('\n')

    const result = formatForTelegram(input)
    expect(result).toContain('X:')
  })
})
