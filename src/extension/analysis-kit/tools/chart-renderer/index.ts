/**
 * Server-side candlestick chart renderer using Chart.js + node-canvas.
 *
 * Produces PNG buffers suitable for Claude vision analysis.
 * Indicators: EMA9, EMA21, BB20, volume bars.
 */

import { ChartJSNodeCanvas } from 'chartjs-node-canvas'
import {
  Chart,
  type ChartConfiguration,
  type ChartDataset,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  LineController,
  LineElement,
  PointElement,
} from 'chart.js'
import 'chartjs-adapter-luxon'
import type { MarketData } from '../../../archive-analysis/data/interfaces.js'
import { createLogger } from '../../../../core/logger.js'

const log = createLogger('chart-renderer')

// Register Chart.js components
Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  LineController,
  LineElement,
  PointElement,
)

// ==================== Types ====================

export interface ChartOptions {
  symbol: string
  bars: MarketData[]
  width?: number
  height?: number
  indicators?: {
    ema9?: boolean
    ema21?: boolean
    bb20?: boolean
    volume?: boolean
  }
}

// ==================== Indicator Math ====================

function ema(closes: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1)
  const result: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length < period) return result

  // Seed with SMA
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  result[period - 1] = sum / period

  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + (result[i - 1] as number) * (1 - k)
  }
  return result
}

function bollingerBands(
  closes: number[],
  period: number,
  stdDev: number,
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(closes.length).fill(null)
  const middle: (number | null)[] = new Array(closes.length).fill(null)
  const lower: (number | null)[] = new Array(closes.length).fill(null)

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = slice.reduce((a, b) => a + b, 0) / period
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period
    const sd = Math.sqrt(variance)
    middle[i] = mean
    upper[i] = mean + stdDev * sd
    lower[i] = mean - stdDev * sd
  }

  return { upper, middle, lower }
}

// ==================== Renderer ====================

const chartPool = new Map<string, ChartJSNodeCanvas>()

function getCanvas(width: number, height: number): ChartJSNodeCanvas {
  const key = `${width}x${height}`
  let canvas = chartPool.get(key)
  if (!canvas) {
    canvas = new ChartJSNodeCanvas({
      width,
      height,
      backgroundColour: '#1a1a2e',
    })
    chartPool.set(key, canvas)
  }
  return canvas
}

/**
 * Render a price chart with optional indicators as a PNG buffer.
 *
 * Uses line chart (close prices) with colored volume bars — simpler and more
 * reliable than full OHLC candlesticks, and Claude vision reads it fine.
 */
export async function renderChart(opts: ChartOptions): Promise<Buffer> {
  const { symbol, bars, width = 800, height = 400, indicators = {} } = opts
  const { ema9 = true, ema21 = true, bb20 = true, volume = true } = indicators

  if (bars.length < 5) throw new Error(`Not enough bars for chart: ${bars.length}`)

  const labels = bars.map((b) => new Date(b.time * 1000).toISOString())
  const closes = bars.map((b) => b.close)
  const opens = bars.map((b) => b.open)
  const volumes = bars.map((b) => b.volume)

  // Price datasets
  const datasets: ChartDataset<'line' | 'bar', (number | null)[]>[] = [
    {
      type: 'line' as const,
      label: `${symbol} Close`,
      data: closes,
      borderColor: '#e0e0e0',
      borderWidth: 1.5,
      pointRadius: 0,
      yAxisID: 'y',
      order: 2,
    },
  ]

  // EMA indicators
  if (ema9) {
    const ema9Data = ema(closes, 9)
    datasets.push({
      type: 'line' as const,
      label: 'EMA 9',
      data: ema9Data,
      borderColor: '#00d4ff',
      borderWidth: 1,
      pointRadius: 0,
      yAxisID: 'y',
      order: 3,
    })
  }

  if (ema21) {
    const ema21Data = ema(closes, 21)
    datasets.push({
      type: 'line' as const,
      label: 'EMA 21',
      data: ema21Data,
      borderColor: '#ff6b6b',
      borderWidth: 1,
      pointRadius: 0,
      yAxisID: 'y',
      order: 3,
    })
  }

  // Bollinger Bands
  if (bb20) {
    const bb = bollingerBands(closes, 20, 2)
    datasets.push(
      {
        type: 'line' as const,
        label: 'BB Upper',
        data: bb.upper,
        borderColor: 'rgba(255, 200, 0, 0.4)',
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
        yAxisID: 'y',
        order: 4,
      } as any,
      {
        type: 'line' as const,
        label: 'BB Lower',
        data: bb.lower,
        borderColor: 'rgba(255, 200, 0, 0.4)',
        borderWidth: 1,
        pointRadius: 0,
        fill: '-1',
        backgroundColor: 'rgba(255, 200, 0, 0.05)',
        yAxisID: 'y',
        order: 4,
      } as any,
    )
  }

  // Volume bars (colored by open/close)
  if (volume) {
    const volumeColors = bars.map((b) =>
      b.close >= b.open ? 'rgba(0, 200, 83, 0.4)' : 'rgba(255, 82, 82, 0.4)',
    )
    datasets.push({
      type: 'bar' as const,
      label: 'Volume',
      data: volumes,
      backgroundColor: volumeColors,
      yAxisID: 'yVol',
      order: 5,
    } as any)
  }

  const config: ChartConfiguration = {
    type: 'line',
    data: { labels, datasets } as any,
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        title: {
          display: true,
          text: `${symbol} — ${bars.length} bars`,
          color: '#e0e0e0',
          font: { size: 14 },
        },
      },
      scales: {
        x: {
          type: 'time',
          ticks: { color: '#888', maxTicksLimit: 10 },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        y: {
          position: 'right',
          ticks: { color: '#e0e0e0' },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
        ...(volume
          ? {
              yVol: {
                position: 'left' as const,
                ticks: { display: false },
                grid: { display: false },
                max: Math.max(...volumes) * 4, // shrink volume to bottom 25%
              },
            }
          : {}),
      },
    },
  }

  const canvas = getCanvas(width, height)
  const buffer = await canvas.renderToBuffer(config as any)
  log.info('chart rendered', { symbol, bars: bars.length, bytes: buffer.length })
  return buffer
}
