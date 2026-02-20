/**
 * EastMoney (东方财富) API client for A-share market data
 *
 * Provides search, real-time quotes, and K-line (OHLCV) data
 * for Chinese A-share stocks via free HTTP APIs.
 */

export interface StockSearchResult {
  code: string
  name: string
  market: number // 1 = Shanghai, 0 = Shenzhen
}

export interface StockQuote {
  code: string
  name: string
  price: number
  open: number
  high: number
  low: number
  volume: number
  amount: number
  changePercent: number
  changeAmount: number
}

export interface KlineBar {
  date: string
  open: number
  close: number
  high: number
  low: number
  volume: number
  amount: number
}

/** Period codes for EastMoney kline API */
export type KlinePeriod = '101' | '102' | '103' | '104' | '105' | '106' | '115'

const PERIOD_MAP: Record<string, KlinePeriod> = {
  daily: '101',
  weekly: '102',
  monthly: '103',
  '5min': '105',
  '15min': '115',
  '30min': '106',
  '60min': '104',
}

/**
 * Detect market code from stock code prefix
 * 1 = Shanghai (600, 601, 603, 688, 510, 511, 513, 515, 560)
 * 0 = Shenzhen (000, 001, 002, 300, 301, 159)
 */
export function detectMarket(code: string): number {
  const prefix3 = code.slice(0, 3)
  const prefix2 = code.slice(0, 2)
  if (['600', '601', '603', '605', '688', '510', '511', '513', '515', '560'].includes(prefix3)) return 1
  if (['000', '001', '002', '003', '300', '301', '159'].includes(prefix3)) return 0
  // Fallback: 6x = Shanghai, others = Shenzhen
  if (prefix2 === '68' || code.startsWith('6')) return 1
  return 0
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.json()
}

/**
 * Search A-share stocks by code or Chinese name
 */
export async function searchStock(query: string): Promise<StockSearchResult[]> {
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(query)}&type=14&token=D43BF722C8E0D9E7&count=10`
  const data = await fetchJson(url)

  const items = data?.QuotationCodeTable?.Data
  if (!Array.isArray(items)) return []

  return items.map((item: any) => ({
    code: item.Code as string,
    name: item.Name as string,
    market: item.MktNum === '1' ? 1 : 0,
  }))
}

/**
 * Get K-line (OHLCV) data for a stock
 *
 * @param code - Stock code, e.g. "600519"
 * @param market - 1 for Shanghai, 0 for Shenzhen (auto-detected if omitted)
 * @param period - "daily" | "weekly" | "monthly" | "5min" | "15min" | "30min" | "60min"
 * @param count - Number of bars to fetch (default 120)
 */
export async function getKline(
  code: string,
  market?: number,
  period: string = 'daily',
  count: number = 120,
): Promise<KlineBar[]> {
  const mkt = market ?? detectMarket(code)
  const klt = PERIOD_MAP[period] ?? '101'
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
    `?secid=${mkt}.${code}` +
    `&klt=${klt}` +
    `&fqt=1` +
    `&lmt=${count}` +
    `&end=20500101` +
    `&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57`

  const data = await fetchJson(url)
  const klines: string[] | undefined = data?.data?.klines
  if (!Array.isArray(klines)) return []

  return klines.map((line) => {
    const [date, open, close, high, low, volume, amount] = line.split(',')
    return {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: Number(amount),
    }
  })
}

/**
 * Get real-time quote for a stock
 */
export async function getQuote(code: string, market?: number): Promise<StockQuote | null> {
  const mkt = market ?? detectMarket(code)
  const url =
    `https://push2.eastmoney.com/api/qt/stock/get` +
    `?secid=${mkt}.${code}` +
    `&fields=f57,f58,f43,f44,f45,f46,f47,f48,f170,f171`

  const data = await fetchJson(url)
  const d = data?.data
  if (!d) return null

  return {
    code: d.f57 ?? code,
    name: d.f58 ?? '',
    price: d.f43 != null ? d.f43 / 100 : 0,
    high: d.f44 != null ? d.f44 / 100 : 0,
    low: d.f45 != null ? d.f45 / 100 : 0,
    open: d.f46 != null ? d.f46 / 100 : 0,
    volume: d.f47 ?? 0,
    amount: d.f48 ?? 0,
    changePercent: d.f170 != null ? d.f170 / 100 : 0,
    changeAmount: d.f171 != null ? d.f171 / 100 : 0,
  }
}
