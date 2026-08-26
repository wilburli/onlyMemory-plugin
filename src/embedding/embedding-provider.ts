/**
 * Embedding 提供者
 *
 * 默认 embeddingBackend='none'，不生成向量，仅使用关键词检索。
 * 用户可通过配置切换为以下后端之一：
 *
 * - 'openai'    — 调用 OpenAI API（需 OPENAI_API_KEY）
 * - 'dashscope' — 调用阿里云 DashScope API（需 DASHSCOPE_API_KEY）
 * - 'local'     — 使用 transformers.js 本地推理（需安装 @xenova/transformers）
 */

import type { MemoryPluginConfig } from '../config.js';

// ================================================================ //
// 接口
// ================================================================ //

export interface EmbeddingProvider {
  /** 将文本转换为向量 */
  embed(text: string): Promise<Float32Array | null>;
  /** 批量转换 */
  embedBatch(texts: string[]): Promise<Array<Float32Array | null>>;
}

// ================================================================ //
// OpenAI / 兼容接口
// ================================================================ //

class OpenAIEmbedding implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(model: string, apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl ?? 'https://api.openai.com/v1';
  }

  async embed(text: string): Promise<Float32Array | null> {
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: text, model: this.model }),
      });
      if (!res.ok) {
        console.error(`[OnlyMemory] OpenAI API error: ${res.status} ${res.statusText}`);
        return null;
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return new Float32Array(data.data[0].embedding);
    } catch (err) {
      console.error('[OnlyMemory] OpenAI embedding failed:', (err as Error).message);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// ================================================================ //
// DashScope (阿里云)
// ================================================================ //

class DashScopeEmbedding implements EmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(model: string, apiKey: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(text: string): Promise<Float32Array | null> {
    try {
      const res = await fetch(
        'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: { texts: [text] },
            parameters: { text_type: 'document' },
          }),
        },
      );
      if (!res.ok) {
        console.error(`[OnlyMemory] DashScope API error: ${res.status} ${res.statusText}`);
        return null;
      }
      const data = (await res.json()) as {
        output: { embeddings: Array<{ embedding: number[] }> };
      };
      return new Float32Array(data.output.embeddings[0].embedding);
    } catch (err) {
      console.error('[OnlyMemory] DashScope embedding failed:', (err as Error).message);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// ================================================================ //
// Local (transformers.js / WASM)
// ================================================================ //

class LocalEmbedding implements EmbeddingProvider {
  private modelName: string;
  private pipe: unknown = null;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  async init(): Promise<void> {
    try {
      // @ts-expect-error — @xenova/transformers 是可选依赖，未安装时不存在类型声明
      const transformers = await import('@xenova/transformers');
      const pipeline = transformers.pipeline as unknown as (
        task: string,
        model: string,
      ) => Promise<{ _call: (texts: string[]) => Promise<{ data: Float32Array }> }>;
      this.pipe = await pipeline('feature-extraction', this.modelName);
    } catch (err) {
      throw new Error(
        `本地 Embedding 需要 @xenova/transformers 包。\n` +
          `安装命令: npm install @xenova/transformers\n` +
          `错误: ${(err as Error).message}`,
      );
    }
  }

  async embed(text: string): Promise<Float32Array | null> {
    try {
      const pipe = this.pipe as {
        _call: (texts: string[], opts: object) => Promise<{ data: Float32Array }>;
      };
      const result = await pipe._call([text], { pooling: 'mean', normalize: true });
      return result.data;
    } catch (err) {
      console.error('[OnlyMemory] Local embedding failed:', (err as Error).message);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// ================================================================ //
// 工厂函数
// ================================================================ //

/**
 * 根据配置创建 Embedding 提供者
 *
 * @returns EmbeddingProvider 实例，或 null（当 backend='none' 或未配置 API Key 时）
 */
export async function createEmbeddingProvider(
  config: MemoryPluginConfig,
): Promise<EmbeddingProvider | null> {
  const backend = config.embeddingBackend;
  const model = config.embeddingModel;

  if (backend === 'none') return null;

  if (backend === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      console.warn('[OnlyMemory] embeddingBackend=openai 但未设置 OPENAI_API_KEY，已降级为关键词检索');
      return null;
    }
    const baseUrl = process.env.OPENAI_BASE_URL;
    return new OpenAIEmbedding(model, key, baseUrl);
  }

  if (backend === 'dashscope') {
    const key = process.env.DASHSCOPE_API_KEY;
    if (!key) {
      console.warn('[OnlyMemory] embeddingBackend=dashscope 但未设置 DASHSCOPE_API_KEY，已降级为关键词检索');
      return null;
    }
    return new DashScopeEmbedding(model, key);
  }

  if (backend === 'local') {
    try {
      const provider = new LocalEmbedding(model);
      await provider.init();
      return provider;
    } catch (err) {
      console.warn(`[OnlyMemory] 本地 Embedding 初始化失败: ${(err as Error).message}`);
      console.warn('[OnlyMemory] 已降级为关键词检索');
      return null;
    }
  }

  return null;
}
