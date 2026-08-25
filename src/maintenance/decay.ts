/**
 * 时间衰减管理器
 *
 * 公式：decayed_importance = importance × exp(-days / halfLife)
 */

import type { Memory } from '../models.js';
import type { SqliteStore } from '../storage/sqlite-store.js';

export class DecayManager {
  private halfLifeDays: number;

  constructor(halfLifeDays: number = 30) {
    this.halfLifeDays = halfLifeDays;
  }

  /** 计算衰减后的分数 */
  decayedScore(importance: number, createdAt: string): number {
    const days = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
    return importance * Math.exp(-days / this.halfLifeDays);
  }

  /** 对所有活跃记忆执行衰减 */
  applyDecay(store: SqliteStore): number {
    const memories = store.getAllActive();
    let updated = 0;

    for (const mem of memories) {
      const newScore = this.decayedScore(mem.importance, mem.createdAt);
      if (Math.abs(newScore - mem.importance) > 0.01) {
        store.updateImportance(mem.id, newScore);
        updated++;
      }
    }

    return updated;
  }
}
