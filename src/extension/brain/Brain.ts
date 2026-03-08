/**
 * Brain - Git-like cognitive state management
 *
 * Tracks frontal lobe (working memory) and emotion state changes,
 * creating a commit for each change to form a complete cognitive change chain.
 */

import { createHash } from 'crypto';
import { createLogger } from '../../core/logger.js';
import type {
  CommitHash,
  BrainCommit,
  BrainCommitType,
  BrainState,
  BrainExportState,
} from './types';

const log = createLogger('brain');

export interface BrainConfig {
  /** Called after each commit for persistence */
  onCommit?: (state: BrainExportState) => void | Promise<void>;
}

function generateCommitHash(content: object): CommitHash {
  return createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex')
    .slice(0, 8);
}

export class Brain {
  private state: BrainState;
  private commits: BrainCommit[] = [];
  private head: CommitHash | null = null;

  constructor(
    private config: BrainConfig,
    initialState?: Partial<BrainState>,
  ) {
    this.state = {
      frontalLobe: initialState?.frontalLobe ?? '',
      emotion: initialState?.emotion ?? 'neutral',
    };
  }

  // ==================== Queries ====================

  getFrontalLobe(): string {
    return this.state.frontalLobe;
  }

  getEmotion(): { current: string; recentChanges: BrainCommit[] } {
    const emotionCommits = this.commits
      .filter((c) => c.type === 'emotion')
      .slice(-10)
      .reverse();
    return { current: this.state.emotion, recentChanges: emotionCommits };
  }

  log(limit = 10): BrainCommit[] {
    return this.commits.slice(-limit).reverse();
  }

  // ==================== Mutations ====================

  updateFrontalLobe(content: string): { success: boolean; message: string } {
    // Skip commit if content is unchanged
    if (this.state.frontalLobe === content) {
      return { success: true, message: 'Frontal lobe unchanged, skipped' };
    }
    this.state.frontalLobe = content;
    this.createCommit('frontal_lobe', content.slice(0, 100));
    return { success: true, message: 'Frontal lobe updated successfully' };
  }

  updateEmotion(
    emotion: string,
    reason: string,
  ): { success: boolean; message: string } {
    // Skip commit if emotion is unchanged
    if (this.state.emotion === emotion) {
      return { success: true, message: `Emotion unchanged (${emotion}), skipped` };
    }
    const from = this.state.emotion;
    this.state.emotion = emotion;
    this.createCommit('emotion', reason);
    return { success: true, message: `Emotion: ${from} → ${emotion}` };
  }

  // ==================== Serialization ====================

  exportState(): BrainExportState {
    return {
      commits: [...this.commits],
      head: this.head,
      state: { ...this.state },
    };
  }

  static restore(state: BrainExportState, config: BrainConfig): Brain {
    const brain = new Brain(config, state.state);
    brain.commits = [...state.commits];
    brain.head = state.head;
    return brain;
  }

  // ==================== Internal ====================

  private createCommit(type: BrainCommitType, message: string): void {
    const hash = generateCommitHash({
      type,
      message,
      state: this.state,
      parentHash: this.head,
      timestamp: Date.now(),
    });

    const commit: BrainCommit = {
      hash,
      parentHash: this.head,
      timestamp: new Date().toISOString(),
      type,
      message,
      stateAfter: { ...this.state },
    };

    this.commits.push(commit);
    this.head = hash;

    // Fire-and-forget with error swallowing — onCommit is for persistence, must not crash the brain
    Promise.resolve(this.config.onCommit?.(this.exportState())).catch((err) => {
      log.error('onCommit callback failed', err instanceof Error ? err.message : String(err));
    });
  }
}
