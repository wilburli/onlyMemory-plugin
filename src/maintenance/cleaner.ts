/**
 * 低分记忆清理器
 */

import type { SqliteStore } from '../storage/sqlite-store.js';

export class MemoryCleaner {
  private threshold: number;

  constructor(threshold: number = 0.1) {
    this.threshold = threshold;
  }

  /** 清理低分记忆 */
  clean(store: SqliteStore): number {
    const lowMemories = store.getLowImportanceMemories(this.threshold);
    let archived = 0;

    for (const mem of lowMemories) {
      if (store.archiveMemory(mem.id)) {
        archived++;
      }
    }

    return archived;
  }
}
