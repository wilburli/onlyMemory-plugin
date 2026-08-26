/**
 * 多路召回 + 综合排序检索器
 *
 * 三路召回：
 * 1. 语义检索（向量余弦相似度）    权重 0.5
 * 2. FTS 全文检索（LIKE 搜索）     权重 0.2
 * 3. 实体匹配检索                  权重 0.15
 * 4. 重要度排序                    权重 0.10
 * 5. 时效性排序                    权重 0.05
 */

import type { Memory, RetrievalResult } from '../models.js';
import type { MemoryPluginConfig } from '../config.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { LocalVectorStore } from '../storage/vector-store.js';
import type { EntityExtractor } from '../encoder/entity-extractor.js';
import type { EmbeddingProvider } from '../embedding/embedding-provider.js';

export class MultiRecallRetriever {
  private config: MemoryPluginConfig;
  private store: SqliteStore;
  private vectorStore: LocalVectorStore;
  private extractor: EntityExtractor;
  private embeddingProvider: EmbeddingProvider | null;

  constructor(
    config: MemoryPluginConfig,
    store: SqliteStore,
    vectorStore: LocalVectorStore,
    extractor: EntityExtractor,
    embeddingProvider: EmbeddingProvider | null = null,
  ) {
    this.config = config;
    this.store = store;
    this.vectorStore = vectorStore;
    this.extractor = extractor;
    this.embeddingProvider = embeddingProvider;
  }

  /** 检索相关记忆并返回格式化的上下文文本 */
  async retrieveContextText(query: string): Promise<string> {
    const results = await this.retrieve(query);
    if (results.length === 0) return '';

    const lines = results.map((r) => `- [${r.memory.type}] ${r.memory.content}`);
    return `## 相关记忆\n${lines.join('\n')}`;
  }

  /** 多路召回检索 */
  async retrieve(query: string): Promise<RetrievalResult[]> {
    const topK = this.config.topK;
    const allResults = new Map<string, RetrievalResult>();
    const scoreAccum = new Map<string, number>();

    // 1. 语义检索（如果有 embedding 提供者）
    if (this.embeddingProvider) {
      const queryEmbedding = await this.embeddingProvider.embed(query);
      if (queryEmbedding) {
        const vectorResults = this.recallVector(queryEmbedding, topK * 2);
        for (const r of vectorResults) {
          const key = r.memory.id;
          scoreAccum.set(key, (scoreAccum.get(key) ?? 0) + r.score * 0.50);
          allResults.set(key, r);
        }
      }
    }

    // 2. FTS 全文检索
    const ftsWeight = this.embeddingProvider ? 0.20 : 0.35;
    const ftsResults = this.recallFts(query, topK * 2);
    for (const r of ftsResults) {
      const key = r.memory.id;
      scoreAccum.set(key, (scoreAccum.get(key) ?? 0) + r.score * ftsWeight);
      allResults.set(key, r);
    }

    // 3. 实体匹配检索
    const entities = this.extractor.extract(query);
    if (entities.length > 0) {
      const entityResults = this.recallEntity(entities, topK * 2);
      for (const r of entityResults) {
        const key = r.memory.id;
        scoreAccum.set(key, (scoreAccum.get(key) ?? 0) + r.score * 0.15);
        if (!allResults.has(key)) allResults.set(key, r);
      }
    }

    // 4. 重要度排序
    const importanceResults = this.recallImportance(topK * 2);
    for (const r of importanceResults) {
      const key = r.memory.id;
      scoreAccum.set(key, (scoreAccum.get(key) ?? 0) + r.score * 0.10);
      if (!allResults.has(key)) allResults.set(key, r);
    }

    // 5. 时效性排序
    const timeResults = this.recallTimeliness(topK * 2);
    for (const r of timeResults) {
      const key = r.memory.id;
      scoreAccum.set(key, (scoreAccum.get(key) ?? 0) + r.score * 0.05);
      if (!allResults.has(key)) allResults.set(key, r);
    }

    // 综合排序
    const sorted = [...allResults.entries()]
      .map(([id, r]) => ({ ...r, score: scoreAccum.get(id) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // 更新访问计数
    for (const r of sorted) {
      this.store.incrementAccessCount(r.memory.id);
    }

    return sorted;
  }

  // ================================================================ //
  // 各路召回实现
  // ================================================================ //

  private recallVector(queryEmbedding: Float32Array, limit: number): RetrievalResult[] {
    const hits = this.vectorStore.search(queryEmbedding, limit);
    const results: RetrievalResult[] = [];
    for (const [id, score] of hits) {
      const mem = this.store.getMemory(id);
      if (!mem) continue;
      results.push({ memory: mem, score, source: 'semantic' });
    }
    return results;
  }

  private recallFts(query: string, limit: number): RetrievalResult[] {
    const hits = this.store.ftsSearch(query, limit);
    if (hits.length === 0) return [];

    // 归一化 FTS 分数（importance 越高越好）
    const maxScore = Math.max(...hits.map(([, s]) => s));
    const minScore = Math.min(...hits.map(([, s]) => s));
    const range = maxScore - minScore || 1;

    const results: RetrievalResult[] = [];
    for (const [id, rawScore] of hits) {
      const mem = this.store.getMemory(id);
      if (!mem) continue;
      const normScore = (rawScore - minScore) / range;
      results.push({ memory: mem, score: normScore, source: 'fts' });
    }
    return results;
  }

  private recallEntity(entities: string[], limit: number): RetrievalResult[] {
    const ids = this.store.entitySearch(entities, limit);
    const results: RetrievalResult[] = [];
    for (const id of ids) {
      const mem = this.store.getMemory(id);
      if (!mem) continue;
      results.push({ memory: mem, score: 0.8, source: 'entity' });
    }
    return results;
  }

  private recallImportance(limit: number): RetrievalResult[] {
    const all = this.store.getAllActive();
    return all.slice(0, limit).map((mem) => ({
      memory: mem,
      score: mem.importance,
      source: 'importance' as const,
    }));
  }

  private recallTimeliness(limit: number): RetrievalResult[] {
    const all = this.store.getAllActive();
    const now = Date.now();

    return all
      .map((mem) => {
        const age = now - new Date(mem.updatedAt).getTime();
        const daysAgo = age / (1000 * 60 * 60 * 24);
        // 越新分数越高，指数衰减
        const score = Math.exp(-daysAgo / 30);
        return { memory: mem, score, source: 'time' as const };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
