/**
 * News Collector — Zod configuration schema
 */

import { z } from 'zod'

const feedSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  source: z.string(),
  categories: z.array(z.string()).optional(),
})

export const newsCollectorSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().positive().default(10),
  maxInMemory: z.number().int().positive().default(2000),
  retentionDays: z.number().int().positive().default(7),
  feeds: z.array(feedSchema).default([
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'coindesk' },
    { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss', source: 'cointelegraph' },
    { name: 'The Block', url: 'https://www.theblock.co/rss.xml', source: 'theblock' },
    { name: 'CNBC Finance', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', source: 'cnbc' },
  ]),
})

export type NewsCollectorConfig = z.infer<typeof newsCollectorSchema>
