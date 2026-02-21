/**
 * Convert AI output (with basic Markdown) to Telegram-safe HTML.
 *
 * Steps:
 * 1. Escape &, <, > to HTML entities
 * 2. Convert ```block``` → <pre>block</pre>
 * 3. Convert `code` → <code>code</code>
 * 4. Convert ## headings → <b>heading</b> (Telegram has no <h> tags)
 * 5. Convert **bold** → <b>bold</b>
 * 6. Convert *italic* → <i>italic</i> (but not inside bold)
 * 7. Convert [text](url) → <a href="url">text</a>
 * 8. Strip remaining # prefixes from headings
 */
export function formatForTelegram(text: string): string {
  // Step 1: Escape HTML entities
  let result = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Step 2: Code blocks first (```...```) — must be before inline code
  result = result.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')

  // Step 3: Inline code (`...`)
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Step 4: Markdown headings (##, ###, ####) → bold text
  // Match lines starting with 1-6 # characters followed by space
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, '<b>$2</b>')

  // Step 5: Bold (**...**)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

  // Step 6: Italic (*...* but not inside bold tags)
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')

  // Step 7: Markdown links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  return result
}
