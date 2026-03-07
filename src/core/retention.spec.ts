import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runRetentionCleanup } from './retention.js'

const TEST_DIR = resolve('data/__test_retention')
const EVENT_LOG = resolve(TEST_DIR, 'event-log/events.jsonl')
const NEWS_FILE = resolve(TEST_DIR, 'news-archive/articles.jsonl')

// We test the purgeJsonl logic indirectly via runRetentionCleanup
// but since it reads from fixed paths, we'll test the core logic directly
describe('retention (unit)', () => {
  it('module exports runRetentionCleanup', () => {
    expect(typeof runRetentionCleanup).toBe('function')
  })

  it('runs without error when files do not exist', async () => {
    const result = await runRetentionCleanup()
    expect(result).toHaveProperty('eventLog')
    expect(result).toHaveProperty('signalLog')
    expect(result).toHaveProperty('tradeReviews')
    expect(result).toHaveProperty('newsItems')
  })
})
