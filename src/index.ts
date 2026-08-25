/**
 * DeepSeek Harness 记忆插件 - Cordis 插件入口
 *
 * 本文件是 Harness 加载的入口点。它遵循 Cordis 插件规范：
 * - 导出 name, Config, inject, apply
 * - 通过 ctx 注册记忆能力到 Harness
 *
 * 在 cordis.yml 中配置：
 * ```yaml
 * - id: memory
 *   name: only-memory
 *   config:
 *     projectId: my-project
 *     topK: 10
 * ```
 *
 * 独立使用（不依赖 Harness）：
 * ```typescript
 * import { MemoryEngine } from 'only-memory';
 *
 * const engine = new MemoryEngine({ projectId: 'test' });
 * await engine.init();
 * engine.remember('用户叫张三');
 * ```
 */

import type { MemoryPluginConfig } from './config.js';

export { MemoryEngine } from './engine.js';
export type { MemoryPluginConfig } from './config.js';
export { DEFAULT_CONFIG } from './config.js';
export type { Memory, SessionSummary, RetrievalResult } from './models.js';
export { MemoryType, MemoryStatus } from './models.js';

// ================================================================ //
// Cordis 插件接口（Harness 环境使用）
// ================================================================ //

/** Cordis Context 类型（使用声明合并，避免硬依赖） */
interface CordisContext {
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  effect(cleanup: () => void | (() => void)): void;
  [key: string]: unknown;
}

/** Cordis 服务类型（llm 服务的简化接口） */
interface LlmService {
  chat?(messages: Array<{ role: string; content: string }>, ...args: unknown[]): Promise<string>;
  [key: string]: unknown;
}

/** 插件名称 */
export const name = 'only-memory';

/** 声明依赖服务 */
export const inject = ['llm'];

/** 插件配置 schema（Schemastery 格式） */
export interface Config {
  projectId: string;
  dataDir: string;
  topK: number;
  importanceThreshold: number;
  halfLifeDays: number;
  embeddingBackend: 'none' | 'openai' | 'dashscope' | 'local';
  summarizerBackend: 'none' | 'openai' | 'dashscope' | 'deepseek';
}

/** Schemastery Schema（动态导入，避免硬依赖） */
export async function getConfigSchema(): Promise<unknown> {
  try {
    const Schema = (await import('@deepseek-ai/schemastery')).default;
    return Schema.object({
      projectId: Schema.string().default('default'),
      dataDir: Schema.string().default(''),
      topK: Schema.number().default(10),
      importanceThreshold: Schema.number().default(0.5),
      halfLifeDays: Schema.number().default(30),
      embeddingBackend: Schema.union(['none', 'openai', 'dashscope', 'local']).default('none'),
      summarizerBackend: Schema.union(['none', 'openai', 'dashscope', 'deepseek']).default('none'),
    });
  } catch {
    // Harness 环境中 Schemastery 可用；独立使用时不需要
    return null;
  }
}

/**
 * Cordis 插件 apply 函数
 *
 * 在 Harness 中被自动调用，将记忆能力注册到 Harness 上下文。
 *
 * 集成方式：
 * 1. 监听 Harness 的对话事件（before/after message）
 * 2. 在对话前检索相关记忆，注入到 system prompt
 * 3. 在对话后提取新信息，存入记忆库
 * 4. 注册记忆管理工具（remember / forget / search）
 */
export async function apply(ctx: CordisContext, config: Partial<Config>): Promise<void> {
  const { MemoryEngine } = await import('./engine.js');

  const engine = new MemoryEngine(config as Partial<MemoryPluginConfig>);
  await engine.init();

  console.log(`[OnlyMemory] 记忆插件已加载 (project: ${config.projectId ?? 'default'})`);

  // ---- 注册清理函数 ----
  ctx.effect(() => {
    return () => {
      engine.close();
      console.log('[OnlyMemory] 记忆插件已卸载');
    };
  });

  // ---- 监听对话事件 ----

  // Hook 1: 对话前 - 检索记忆
  ctx.on('before-message', (event: unknown) => {
    const e = event as { content?: string; systemPrompt?: string };
    if (!e?.content) return;

    const memoryContext = engine.onUserMessage(e.content);
    if (memoryContext && e.systemPrompt) {
      e.systemPrompt += '\n\n' + memoryContext;
    }
  });

  // Hook 2: 对话后 - 存储记忆
  ctx.on('after-message', (event: unknown) => {
    const e = event as { content?: string; userMessage?: string };
    if (e?.content) {
      engine.onAssistantMessage(e.content, e.userMessage ?? '');
    }
  });

  // ---- 注册工具（如果 tools 服务可用） ----
  const tools = ctx.tools as {
    register?: (tool: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }) => void;
  } | undefined;

  if (tools?.register) {
    // 工具: remember - 记住一条信息
    tools.register({
      name: 'memory_remember',
      description: '记住一条重要信息，后续对话会自动回忆',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记住的内容' },
          importance: { type: 'number', description: '重要性 0-1', default: 1.0 },
        },
        required: ['content'],
      },
      execute: async (args) => {
        engine.remember(args.content as string, (args.importance as number) ?? 1.0);
        return `已记住: ${args.content}`;
      },
    });

    // 工具: forget - 遗忘信息
    tools.register({
      name: 'memory_forget',
      description: '删除与指定内容相关的记忆',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要遗忘的内容关键词' },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const deleted = engine.forget(args.query as string);
        return `已删除 ${deleted} 条相关记忆`;
      },
    });

    // 工具: search - 搜索记忆
    tools.register({
      name: 'memory_search',
      description: '搜索已有的记忆信息',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const results = engine.search(args.query as string);
        if (results.length === 0) return '未找到相关记忆';
        return results
          .map((r) => `[${r.memory.type}] ${r.memory.content} (相关度: ${(r.score * 100).toFixed(0)}%)`)
          .join('\n');
      },
    });
  }
}
