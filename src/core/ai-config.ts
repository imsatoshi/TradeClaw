import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export type AIProvider = 'claude-code' | 'vercel-ai-sdk'

interface AIConfig {
  provider: AIProvider
}

const CONFIG_PATH = resolve('data/config/ai-provider.json')
const DEFAULT_PROVIDER: AIProvider = 'vercel-ai-sdk'

export async function readAIConfig(): Promise<AIConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as AIConfig
    return parsed
  } catch {
    return { provider: DEFAULT_PROVIDER }
  }
}

export async function writeAIConfig(provider: AIProvider): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify({ provider }, null, 2) + '\n')
}
