/**
 * 纯 JS 内存向量检索
 *
 * 将 embedding 加载到内存中，用余弦相似度做向量检索。
 * 适用于中小规模（< 10万条）记忆库。
 */

/** 余弦相似度 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface VectorEntry {
  id: string;
  embedding: Float32Array;
}

export class LocalVectorStore {
  private entries: Map<string, Float32Array> = new Map();

  /** 加载向量集合 */
  load(entries: VectorEntry[]): void {
    this.entries.clear();
    for (const e of entries) {
      this.entries.set(e.id, e.embedding);
    }
  }

  /** 添加单条向量 */
  add(id: string, embedding: Float32Array): void {
    this.entries.set(id, embedding);
  }

  /** 删除向量 */
  remove(id: string): void {
    this.entries.delete(id);
  }

  /** 获取向量数量 */
  get size(): number {
    return this.entries.size;
  }

  /** 搜索最相似的 topK 条 */
  search(query: Float32Array, topK: number): Array<[string, number]> {
    if (this.entries.size === 0) return [];

    const scores: Array<[string, number]> = [];
    for (const [id, vec] of this.entries) {
      const sim = cosineSimilarity(query, vec);
      scores.push([id, sim]);
    }

    scores.sort((a, b) => b[1] - a[1]);
    return scores.slice(0, topK);
  }

  /** 清空 */
  clear(): void {
    this.entries.clear();
  }
}
