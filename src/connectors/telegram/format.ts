/**
 * Convert AI output (with basic Markdown) to Telegram-safe HTML.
 *
 * Steps:
 * 1. Escape &, <, > to HTML entities
 * 2. Convert ```block``` → <pre>block</pre>
 * 3. Convert `code` → <code>code</code>
 * 4. Convert **bold** → <b>bold</b>
 * 5. Convert *italic* → <i>italic</i> (but not inside bold)
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

  // Step 4: Bold (**...**)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

  // Step 5: Italic (*...* but not inside bold tags)
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')

  return result
}
