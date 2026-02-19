import type { MarketData, NewsItem } from './interfaces'

const API_URL = 'https://dotapi.wond.dev/sandbox/realtime-data'

export interface DotApiResponse {
  currentTime: string
  lastUpdated: string
  marketData: Record<string, MarketData[]>
  news: NewsItem[]
}

interface RawNewsItem {
  time: string
  title: string
  content: string
  metadata: Record<string, string | null>
}

export async function fetchRealtimeData(): Promise<DotApiResponse> {
  const res = await fetch(API_URL)
  if (!res.ok) throw new Error(`DotAPI error: ${res.status}`)
  const raw = await res.json()
  return {
    ...raw,
    news: (raw.news as RawNewsItem[]).map((n) => ({
      ...n,
      time: new Date(n.time),
    })),
  }
}
