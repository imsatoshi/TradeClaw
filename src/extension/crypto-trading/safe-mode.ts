/**
 * Crypto Safe Mode — runtime readOnly guard.
 *
 * Reads `readOnly` from data/config/crypto.json on every call (no cache)
 * so flipping the flag takes effect immediately without restart.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const CONFIG_PATH = resolve('data/config/crypto.json')

export async function isCryptoReadOnly(): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'))
    return raw.readOnly === true
  } catch {
    return false
  }
}
