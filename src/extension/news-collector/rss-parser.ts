/**
 * News Collector — Zero-dependency RSS / Atom parser
 */

export interface ParsedFeedItem {
  title: string
  content: string
  link: string | null
  guid: string | null
  pubDate: Date | null
}

export async function fetchAndParseFeed(url: string, retries = 1): Promise<ParsedFeedItem[]> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'TradeClaw/1.0 NewsCollector' },
      })
      if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`)
      const xml = await res.text()
      return parseRSSXml(xml)
    } catch (err) {
      lastError = err
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw lastError
}

export function parseRSSXml(xml: string): ParsedFeedItem[] {
  const items: ParsedFeedItem[] = []
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    items.push({
      title: cleanText(extractTagRaw(block, 'title') ?? ''),
      content: cleanText(
        extractTagRaw(block, 'content:encoded')
        ?? extractTagRaw(block, 'description')
        ?? extractTagRaw(block, 'summary')
        ?? extractTagRaw(block, 'content')
        ?? '',
      ),
      link: extractTag(block, 'link') ?? extractAttr(block, 'link', 'href'),
      guid: extractTag(block, 'guid') ?? extractTag(block, 'id'),
      pubDate: parseDate(
        extractTag(block, 'pubDate')
        ?? extractTag(block, 'published')
        ?? extractTag(block, 'updated'),
      ),
    })
  }
  return items
}

function extractTagRaw(xml: string, tag: string): string | null {
  const cdataRegex = new RegExp(`<${escapeRegex(tag)}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${escapeRegex(tag)}>`, 'i')
  const cdataMatch = cdataRegex.exec(xml)
  if (cdataMatch) return cdataMatch[1].trim()
  const regex = new RegExp(`<${escapeRegex(tag)}[^>]*>([\\s\\S]*?)</${escapeRegex(tag)}>`, 'i')
  const match = regex.exec(xml)
  return match ? match[1].trim() : null
}

function cleanText(raw: string): string {
  return decodeXmlEntities(stripHtml(raw))
}

function extractTag(xml: string, tag: string): string | null {
  const cdataRegex = new RegExp(`<${escapeRegex(tag)}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${escapeRegex(tag)}>`, 'i')
  const cdataMatch = cdataRegex.exec(xml)
  if (cdataMatch) return cdataMatch[1].trim()
  const regex = new RegExp(`<${escapeRegex(tag)}[^>]*>([\\s\\S]*?)</${escapeRegex(tag)}>`, 'i')
  const match = regex.exec(xml)
  return match ? decodeXmlEntities(match[1].trim()) : null
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const regex = new RegExp(`<${escapeRegex(tag)}[^>]*${attr}="([^"]*)"`, 'i')
  const match = regex.exec(xml)
  return match ? match[1] : null
}

function parseDate(dateStr: string | null): Date | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  return isNaN(d.getTime()) ? null : d
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
