import { tool } from 'ai'
import { z } from 'zod'
import type { CronEngine } from '../../core/cron.js'

// ==================== Schedule Schema ====================

/**
 * Zod discriminated union for the three schedule types.
 * The model picks one of: at (one-shot), every (interval), cron (expression).
 */
const atSchedule = z.object({
  kind: z.literal('at'),
  at: z
    .string()
    .describe('ISO 8601 timestamp for one-shot execution, e.g. "2025-03-01T09:00:00Z"'),
})

const everySchedule = z.object({
  kind: z.literal('every'),
  every: z
    .string()
    .describe('Interval duration, e.g. "2h", "30m", "5m30s"'),
})

const cronSchedule = z.object({
  kind: z.literal('cron'),
  cron: z
    .string()
    .describe('Standard 5-field cron expression (min hour dom month dow), e.g. "0 9 * * 1-5" for weekdays at 9am'),
})

const scheduleSchema = z.discriminatedUnion('kind', [atSchedule, everySchedule, cronSchedule])

// ==================== Tool Factory ====================

/**
 * Create cron management tools for the AI agent.
 *
 * Allows the agent to autonomously create, modify, and manage
 * scheduled tasks (cron jobs) that inject system events into
 * the heartbeat loop.
 */
export function createCronTools(cronEngine: CronEngine) {
  return {
    cronList: tool({
      description: `
List all scheduled cron jobs.

Returns an array of jobs, each with:
- id: Short identifier (use this for update/remove/runNow)
- name: Human-readable name
- enabled: Whether the job is active
- schedule: When it runs (at/every/cron)
- payload: The message delivered to you when it fires
- sessionTarget: "main" (inject into heartbeat) or "isolated" (separate session)
- state: Runtime info (nextRunAtMs, lastRunAtMs, lastStatus, consecutiveErrors)
      `.trim(),
      inputSchema: z.object({}),
      execute: async () => {
        const jobs = await cronEngine.list()
        return { jobs }
      },
    }),

    cronAdd: tool({
      description: `
Create a new scheduled job.

The job will fire according to the schedule and deliver the payload text to you
as a system event during the next heartbeat tick.

Schedule types:
- at: One-shot at a specific time. E.g. { kind: "at", at: "2025-06-01T14:00:00Z" }
- every: Repeating interval. E.g. { kind: "every", every: "2h" } or { kind: "every", every: "30m" }
- cron: Cron expression. E.g. { kind: "cron", cron: "0 9 * * 1-5" } (weekdays 9am)

Returns the new job's id.
      `.trim(),
      inputSchema: z.object({
        name: z
          .string()
          .describe('Short descriptive name for the job, e.g. "Check ETH funding rate"'),
        schedule: scheduleSchema,
        payload: z
          .string()
          .describe('The reminder/instruction text delivered to you when the job fires'),
        sessionTarget: z
          .enum(['main', 'isolated'])
          .optional()
          .describe('Where to run: "main" injects into heartbeat session (default), "isolated" runs in a fresh session'),
        enabled: z
          .boolean()
          .optional()
          .describe('Whether the job starts enabled (default: true)'),
      }),
      execute: async ({ name, schedule, payload, sessionTarget, enabled }) => {
        const id = await cronEngine.add({ name, schedule, payload, sessionTarget, enabled })
        const job = await cronEngine.get(id)
        return { id, job }
      },
    }),

    cronUpdate: tool({
      description: `
Update an existing cron job. Only provided fields are changed.

Use cronList first to get the job id.
If you change the schedule, the next run time is automatically recomputed.
      `.trim(),
      inputSchema: z.object({
        id: z.string().describe('Job id (from cronList)'),
        name: z.string().optional().describe('New name'),
        schedule: scheduleSchema.optional().describe('New schedule'),
        payload: z.string().optional().describe('New payload text'),
        sessionTarget: z.enum(['main', 'isolated']).optional().describe('New session target'),
        enabled: z.boolean().optional().describe('Enable or disable the job'),
      }),
      execute: async ({ id, ...patch }) => {
        await cronEngine.update(id, patch)
        const job = await cronEngine.get(id)
        return { updated: true, job }
      },
    }),

    cronRemove: tool({
      description: 'Remove a cron job permanently. Use cronList first to get the job id.',
      inputSchema: z.object({
        id: z.string().describe('Job id to remove'),
      }),
      execute: async ({ id }) => {
        await cronEngine.remove(id)
        return { removed: true, id }
      },
    }),

    cronRunNow: tool({
      description: `
Manually trigger a cron job immediately, bypassing its schedule.

The job's payload will be injected as a system event and the scheduler will wake.
This does not affect the job's normal schedule — the next scheduled run remains unchanged.
      `.trim(),
      inputSchema: z.object({
        id: z.string().describe('Job id to trigger'),
      }),
      execute: async ({ id }) => {
        await cronEngine.runNow(id)
        const job = await cronEngine.get(id)
        return { triggered: true, job }
      },
    }),
  }
}
