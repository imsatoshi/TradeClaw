/**
 * Convert AI output (with basic Markdown) to Telegram-safe HTML.
 *
 * Steps:
 * 1. Escape &, <, > to HTML entities
 * 2. Convert ```block``` → <pre>block</pre>
 * 3. Convert Markdown tables → Telegram-friendly format
 * 4. Convert `code` → <code>code</code>
 * 5. Convert ## headings → <b>heading</b> (Telegram has no <h> tags)
 * 6. Convert **bold** → <b>bold</b>
 * 7. Convert *italic* → <i>italic</i> (but not inside bold)
 * 8. Convert [text](url) → <a href="url">text</a>
 */
export function formatForTelegram(text: string): string {
  // Step 1: Escape HTML entities
  let result = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Step 2: Code blocks first (```...```) — must be before inline code
  result = result.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')

  // Step 3: Convert Markdown tables to Telegram-friendly format
  // Must run before bold/italic conversion since table cells may contain * markers
  result = convertTables(result)

  // Step 4: Inline code (`...`)
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Step 5: Markdown headings (##, ###, ####) → bold text
  // Match lines starting with 1-6 # characters followed by space
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, '<b>$2</b>')

  // Step 6: Bold (**...**)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

  // Step 7: Italic (*...* but not inside bold tags)
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')

  // Step 8: Markdown links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  return result
}

/**
 * Convert Markdown tables to Telegram-readable format.
 *
 * Strategy:
 * - 2-column tables → "key: value" list (most natural for Telegram)
 * - 3+ column tables → <pre> monospace block (preserves alignment)
 * - Separator rows (|---|---|) are stripped
 */
function convertTables(text: string): string {
  const lines = text.split('\n')
  const output: string[] = []
  let i = 0

  while (i < lines.length) {
    // Detect table: line starts and ends with | (after trimming)
    if (isTableRow(lines[i])) {
      const tableLines: string[] = []

      // Collect all consecutive table rows
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i])
        i++
      }

      // Parse: separate header, separator, and data rows
      const parsed = parseTable(tableLines)
      if (parsed) {
        output.push(formatTable(parsed))
      } else {
        // Failed to parse — keep original lines
        output.push(...tableLines)
      }
    } else {
      output.push(lines[i])
      i++
    }
  }

  return output.join('\n')
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2
}

interface ParsedTable {
  headers: string[]
  rows: string[][]
}

function parseTable(lines: string[]): ParsedTable | null {
  if (lines.length < 2) return null

  const parseCells = (line: string): string[] =>
    line.trim().slice(1, -1).split('|').map(c => c.trim())

  const headers = parseCells(lines[0])
  if (headers.length === 0) return null

  const rows: string[][] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCells(lines[i])
    // Skip separator rows (|---|---|)
    if (cells.every(c => /^[-:]+$/.test(c))) continue
    rows.push(cells)
  }

  return rows.length > 0 ? { headers, rows } : null
}

function formatTable(table: ParsedTable): string {
  const { headers, rows } = table

  // 2-column tables → clean "key: value" list
  if (headers.length === 2) {
    return rows
      .map(r => `  ${r[0] ?? ''}: ${r[1] ?? ''}`)
      .join('\n')
  }

  // 3+ column tables → <pre> monospace block for alignment
  const allRows = [headers, ...rows]

  // Calculate column widths
  const colWidths = headers.map((_, colIdx) =>
    Math.max(...allRows.map(r => (r[colIdx] ?? '').length)),
  )

  // Build padded rows
  const formattedRows = allRows.map(row =>
    row.map((cell, colIdx) => (cell ?? '').padEnd(colWidths[colIdx])).join('  '),
  )

  // Add a separator after header
  const separator = colWidths.map(w => '─'.repeat(w)).join('──')
  formattedRows.splice(1, 0, separator)

  return '<pre>\n' + formattedRows.join('\n') + '\n</pre>'
}
