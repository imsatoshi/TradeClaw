/**
 * News Collector — Public exports
 */

export { NewsCollectorStore, computeDedupKey, parseLookback } from './store.js'
export type { NewsCollectorStoreOpts } from './store.js'
export { NewsCollector } from './collector.js'
export type { CollectorOpts } from './collector.js'
export { createNewsArchiveTools } from './tools.js'
export { newsCollectorSchema } from './config.js'
export type { NewsCollectorConfig } from './config.js'
export type { NewsRecord, RSSFeedConfig, IngestSource, NewsItem, INewsProvider, GetNewsV2Options } from './types.js'
