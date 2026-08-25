# OnlyMemory  GitHub topic dsh-plugin 

零外部依赖的 LLM 长期记忆插件，专为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 设计。

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [架构概览](#架构概览)
- [模块详解](#模块详解)
- [配置参考](#配置参考)
- [MCP 工具清单](#mcp-工具清单)
- [二次开发指南](#二次开发指南)
- [数据存储结构](#数据存储结构)
- [常见问题](#常见问题)

---

## 特性

- **零外部依赖** — 不需要向量数据库、Redis、PostgreSQL 等外部服务
- **SQLite + 纯 JS 向量检索** — sql.js（WASM）实现，单文件存储
- **多项目隔离** — 不同项目记忆完全独立
- **MCP 标准协议** — 通过 `@deepseek-ai/dsh-mcp-client` 与 Harness 无缝集成
- **模块化设计** — 每个子模块可独立替换和扩展
- **导入导出** — JSON 格式，支持跨机器迁移

---

## 快速开始

### 安装到 Harness

```bash
# 方式一：dsh plugin add（推荐，永久生效）
dsh plugin --profile web add ./path/to/onlyMemory-plugin

# 方式二：--patch（临时使用）
dsh web --patch ./path/to/onlyMemory-plugin/cordis-patch.yml

# 卸载
dsh plugin --profile web remove only-memory
```

> **首次安装报 `ERR_PNPM_ADDING_TO_ROOT`？** 在 profile 目录创建 `.npmrc`：
> ```powershell
> echo "ignore-workspace-root-check=true" > $env:USERPROFILE\.dsh\profiles\web\.npmrc
> ```

### 本地开发

```bash
npm install          # 安装依赖
npm run build        # 编译 TypeScript → dist/
npm run test         # 运行测试
npm run dev          # watch 模式编译
```

### 独立使用（不依赖 Harness）

```typescript
import { MemoryEngine } from './dist/engine.js';

const engine = new MemoryEngine({ projectId: 'my-app' });
await engine.init();

// 存储
await engine.remember('用户名叫张三，在北京工作', 0.9);

// 检索
const results = await engine.search('用户在哪里工作？');

// 对话集成
const context = await engine.onUserMessage('你好，还记得我吗？');
await engine.onAssistantMessage('当然记得，你是张三，在北京工作。');

// 会话结束触发自动维护（衰减、去重、清理）
await engine.endSession('session-001');

engine.close();
```

---

## 架构概览

```
Harness (dsh web)
  └── @deepseek-ai/dsh-mcp-client  ──stdio──▶  node bin/only-memory.mjs
                                                    │
                                              ┌─────┴─────┐
                                              │ MemoryEngine │  src/engine.ts
                                              └─────┬─────┘
                    ┌───────────┬───────────┬───────┼───────┬───────────┐
                    ▼           ▼           ▼       ▼       ▼           ▼
              ┌──────────┐ ┌────────┐ ┌────────┐ ┌──────┐ ┌──────┐ ┌──────────┐
              │ SqliteStore│ │Vector │ │Session │ │Scorer│ │Retrie│ │Maintenance│
              │  (sql.js) │ │ Store  │ │ Store  │ │      │ │ ver  │ │  (3个)   │
              └──────────┘ └────────┘ └────────┘ └──────┘ └──────┘ └──────────┘
               storage/     storage/   storage/  scorer/ retriever/ maintenance/
```

### 数据流

```
用户消息 ──▶ onUserMessage()
              ├── EntityExtractor.extract()      提取实体
              ├── MultiRecallRetriever.retrieve() 多路召回
              └── 返回相关记忆上下文

助手消息 ──▶ onAssistantMessage()
              ├── ImportanceScorer.score()       计算重要性
              ├── SqliteStore.insertMemory()      持久化
              └── LocalVectorStore.add()          向量索引

会话结束 ──▶ endSession()
              ├── DecayManager.applyDecay()       时间衰减
              ├── MemoryMerger.merge()            去重合并
              └── MemoryCleaner.clean()           低分清理
```

---

## 模块详解

### `src/models.ts` — 数据模型

| 导出 | 说明 |
|------|------|
| `enum MemoryType` | `Fact` / `Preference` / `Event` / `Behavior` |
| `enum MemoryStatus` | `Active` / `Archived` / `Deleted` |
| `enum RelationType` | `Contradicts` / `Supports` / `Updates` / `Relates` |
| `interface Memory` | 记忆条目（id, content, type, entities, importance, embedding, status...） |
| `interface SessionSummary` | 会话摘要 |
| `interface RetrievalResult` | 检索结果（memory + score + channels） |
| `interface CreateMemoryInput` | 创建记忆参数 |
| `generateId()` | 生成 UUID |
| `createMemory()` | 创建新 Memory 对象 |

### `src/config.ts` — 配置管理

```typescript
interface MemoryPluginConfig {
  projectId: string;              // 项目标识，默认 'default'
  dataDir: string;                // 数据根目录，默认 ~/.deepseek_mem
  dbName: string;                 // 数据库文件名，默认 'memory.db'
  topK: number;                   // 检索返回条数，默认 5
  importanceThreshold: number;    // 重要性过滤阈值，默认 0.3
  halfLifeDays: number;           // 衰减半衰期（天），默认 30
  embeddingBackend: 'none' | 'openai' | 'dashscope' | 'local';
  embeddingModel: string;         // Embedding 模型名
  embeddingDim: number;           // 向量维度，默认 1536
  summarizerBackend: 'none' | 'openai' | 'dashscope' | 'deepseek';
}
```

辅助函数：`resolveConfig()` / `getProjectDir()` / `getDbPath()` / `getSessionDir()` / `ensureDirs()`

### `src/engine.ts` — 核心引擎

`MemoryEngine` 是整合所有子模块的主类：

| 方法 | 签名 | 说明 |
|------|------|------|
| `constructor` | `(config?: Partial<MemoryPluginConfig>)` | 创建引擎实例 |
| `init()` | `async (): Promise<void>` | 异步初始化（加载 WASM、数据库、向量） |
| `remember()` | `(content: string, importance?: number): Promise<Memory>` | 显式存储一条记忆 |
| `forget()` | `(query: string): Promise<number>` | 按关键词删除记忆，返回删除数 |
| `search()` | `(query: string, limit?: number): Promise<RetrievalResult[]>` | 搜索记忆 |
| `getAllMemories()` | `(): Memory[]` | 获取所有活跃记忆 |
| `getStats()` | `(): object` | 获取统计信息 |
| `onUserMessage()` | `(text: string): Promise<string>` | 处理用户消息，返回相关记忆上下文 |
| `onAssistantMessage()` | `(text: string): Promise<void>` | 处理助手消息，提取并存储信息 |
| `startSession()` | `(sessionId: string): void` | 开始会话 |
| `endSession()` | `(sessionId: string): Promise<void>` | 结束会话，触发维护 |
| `exportToFile()` | `(filePath: string): Promise<void>` | 导出为 JSON |
| `importFromFile()` | `(filePath: string): Promise<number>` | 从 JSON 导入 |
| `close()` | `(): void` | 关闭引擎 |

### `src/storage/sqlite-store.ts` — SQLite 存储

基于 sql.js（纯 JS/WASM），内存操作 + 延迟批量写盘：

| 方法 | 说明 |
|------|------|
| `init()` | 异步初始化，加载 WASM 并打开/创建数据库 |
| `insertMemory(memory)` | 插入记忆 |
| `getMemory(id)` | 按 ID 获取 |
| `updateImportance(id, score)` | 更新重要性 |
| `incrementAccessCount(id)` | 增加访问计数 |
| `archiveMemory(id)` / `deleteMemory(id)` | 归档/删除 |
| `getAllActive()` / `getActiveCount()` | 查询活跃记忆 |
| `ftsSearch(query, limit)` | LIKE 全文搜索 |
| `entitySearch(entities, limit)` | 实体匹配搜索 |
| `getLowImportanceMemories(threshold)` | 获取低分记忆 |
| `saveSessionLog(session)` | 保存会话日志 |
| `exportAll()` | 导出全部记忆为 JSON |
| `flush()` | 强制写盘 |
| `close()` | 关闭数据库 |

> WASM 路径通过环境变量 `SQL_JS_WASM_PATH` 指定，支持自定义安装位置。

### `src/storage/vector-store.ts` — 向量检索

纯 JS 内存向量存储，余弦相似度计算：

```typescript
cosineSimilarity(a: Float32Array, b: Float32Array): number

class LocalVectorStore {
  load(entries: VectorEntry[]): void
  add(id: string, embedding: Float32Array): void
  remove(id: string): void
  search(query: Float32Array, topK: number): { id: string; score: number }[]
  clear(): void
  get size(): number
}
```

### `src/storage/session-store.ts` — 会话存储

JSON 文件存储会话摘要：`save()` / `load()` / `list()`

### `src/encoder/entity-extractor.ts` — 实体抽取

正则匹配，支持：中文人名、英文专有名词、技术名词、邮箱地址。

```typescript
class EntityExtractor {
  extract(text: string): string[]
}
```

### `src/scorer/importance.ts` — 重要性评分

6 因子加权评分（总分 0~1）：

| 因子 | 权重 | 说明 |
|------|------|------|
| `explicit` | 0.30 | 显式指令（"请记住"、"important"） |
| `novelty` | 0.20 | 新颖性（基于文本长度代理） |
| `emotion` | 0.10 | 情感强度（感叹号、情感词） |
| `entity` | 0.15 | 实体密度 |
| `behavior` | 0.15 | 行为信息（偏好、习惯） |
| `timeliness` | 0.10 | 时效性（含日期信息） |

```typescript
interface ScoreResult { score: number; factors: Record<string, number> }

class ImportanceScorer {
  constructor(extractor: EntityExtractor)
  score(text: string, type: MemoryType): ScoreResult
}
```

### `src/retriever/multi-recall.ts` — 多路召回

4 路召回 + 加权融合排序：

| 召回通道 | 权重 | 实现 |
|----------|------|------|
| FTS 全文 | 0.20 | SQLite LIKE 查询 |
| 实体匹配 | 0.15 | 正则提取实体交叉匹配 |
| 重要度 | 0.10 | importance 字段排序 |
| 时效性 | 0.05 | 创建时间排序 |

> 语义向量召回在 `embeddingBackend` 配置后自动启用（额外权重 0.50）。

```typescript
class MultiRecallRetriever {
  retrieve(query: string, limit: number): Promise<RetrievalResult[]>
  retrieveContextText(query: string, limit?: number): Promise<string>
}
```

### `src/maintenance/` — 维护子系统

| 模块 | 类 | 核心方法 | 说明 |
|------|-----|----------|------|
| `decay.ts` | `DecayManager` | `decayedScore(score, createdAt)` / `applyDecay(store)` | 指数衰减，半衰期可配 |
| `merger.ts` | `MemoryMerger` | `merge(store)` | bigram Jaccard 相似度去重合并 |
| `cleaner.ts` | `MemoryCleaner` | `clean(store)` | 清理低于阈值的记忆 |

---

## 配置参考

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ONLYMEM_PROJECT` | `default` | 项目标识 |
| `ONLYMEM_DATA_DIR` | `~/.onlymem` | 数据存储目录 |
| `SQL_JS_WASM_PATH` | 自动探测 | sql.js WASM 文件路径 |

### Harness patch 配置

通过 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- set:
    id: memory-onlymemory
    config:
      serverName: only_memory
      env:
        ONLYMEM_PROJECT: my-project
        ONLYMEM_DATA_DIR: /custom/data/path
```

---

## MCP 工具清单

安装后 Harness 自动发现 7 个工具（前缀 `mcp__only_memory__`）：

| 工具 | 参数 | 说明 |
|------|------|------|
| `remember` | `content: string`, `importance?: number` | 记住一条信息 |
| `forget` | `query: string` | 按关键词遗忘 |
| `search` | `query: string`, `limit?: number` | 搜索记忆 |
| `stats` | 无 | 记忆库统计 |
| `list_memories` | `limit?: number` | 列出所有记忆 |
| `export_memories` | `path: string` | 导出到 JSON 文件 |
| `import_memories` | `path: string` | 从 JSON 导入 |

---

## 二次开发指南

### 添加新的召回通道

在 `src/retriever/multi-recall.ts` 中扩展：

```typescript
// 1. 添加新的召回方法
private async recallKnowledgeGraph(query: string, limit: number): Promise<RetrievalResult[]> {
  // 你的召回逻辑
}

// 2. 在 retrieve() 中注册新通道
const channels = [
  // ...existing
  { name: 'knowledge_graph', weight: 0.15, fn: this.recallKnowledgeGraph.bind(this) },
];
```

### 替换 Embedding 后端

在 `src/storage/vector-store.ts` 中添加适配器：

```typescript
// 当前 MVP 使用纯文本匹配，接入 Embedding 后：
async function getEmbedding(text: string): Promise<Float32Array> {
  // 调用 OpenAI / DashScope / 本地模型 API
}
```

在 `engine.ts` 的 `onAssistantMessage()` 中调用：

```typescript
const embedding = await getEmbedding(text);
this.vectorStore.add(memory.id, embedding);
```

### 自定义评分因子

在 `src/scorer/importance.ts` 中：

```typescript
// 添加新因子
private scoreSocialSignal(text: string): number {
  // 检测 @提及、引用等社交信号
}

// 在 score() 中注册并设置权重
factors.social = this.scoreSocialSignal(text);
weights.social = 0.10;  // 调整其他权重使总和 = 1.0
```

### 添加新的存储后端

实现与 `SqliteStore` 相同的接口即可替换：

```typescript
// src/storage/pg-store.ts
export class PostgresStore {
  async init(): Promise<void> { /* 连接 PostgreSQL */ }
  async insertMemory(memory: Memory): Promise<void> { /* ... */ }
  // ... 实现 SqliteStore 的所有公开方法
}

// 在 engine.ts 的 init() 中替换
this.store = new PostgresStore(connectionString);
```

### 添加新的 MCP 工具

在 `src/mcp-server.ts` 中注册：

```typescript
import { z } from 'zod';

server.tool(
  'tag_memory',                        // 工具名
  'Add tags to a memory entry',        // 描述（模型据此决定调用）
  { id: z.string(), tags: z.array(z.string()) },  // zod schema
  async ({ id, tags }) => {
    // 实现逻辑
    return { content: [{ type: 'text', text: `Tagged ${id}` }] };
  }
);
```

### 添加 Cordis 事件钩子

在 `src/index.ts` 的 `apply()` 中：

```typescript
ctx.on('before-message', async (session, message) => {
  // 消息到达前的处理
});

ctx.on('after-message', async (session, message) => {
  // 消息处理后的钩子
});
```

### 编写测试

参考 `tests/test.ts`：

```typescript
import { MemoryEngine } from '../src/engine.js';

const engine = new MemoryEngine({ dataDir: '/tmp/test-mem' });
await engine.init();

// 测试存储
const mem = await engine.remember('测试内容', 0.8);
console.assert(mem.content === '测试内容');

// 测试搜索
const results = await engine.search('测试');
console.assert(results.length > 0);

engine.close();
```

---

## 数据存储结构

```
~/.onlymem/
  default/                          ← 默认项目
    memory.db                       ← SQLite 数据库
    sessions/                       ← 会话摘要 (JSON)
      2026-08-25-session-001.json
  my-project/                       ← 自定义项目
    memory.db
    sessions/
```

### SQLite 表结构

| 表 | 字段 | 说明 |
|----|------|------|
| `memories` | `id TEXT PK` | 记忆条目 |
| | `content TEXT` | 记忆内容 |
| | `type TEXT` | fact/preference/event/behavior |
| | `entities TEXT` | JSON 数组，提取的实体 |
| | `importance REAL` | 重要性分数 0~1 |
| | `embedding BLOB` | Float32Array 向量 |
| | `status TEXT` | active/archived/deleted |
| | `access_count INTEGER` | 访问计数 |
| | `created_at TEXT` | 创建时间 |
| `memory_relations` | `from_id`, `to_id`, `relation_type` | 记忆间关系 |
| `session_logs` | `session_id PK`, `summary`, `memory_count` | 会话日志 |

---

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `ERR_PNPM_ADDING_TO_ROOT` | pnpm workspace 拒绝向 root 添加依赖 | 创建 `.npmrc` 加 `ignore-workspace-root-check=true` |
| `__dirname is not defined` | Harness `!!js` 上下文无此变量 | 已修复，使用 `process.getBuiltinModule` 动态定位 |
| `EADDRINUSE 3080` | 端口被占用 | `dsh web --port 3081` |
| MCP 工具未出现 | 插件未加载 | 检查 `dsh --profile web --dump-config` 输出中是否有 `memory-deepseek` |
| 记忆为空 | 未触发存储 | 需先进行对话让模型调用 `remember` 工具 |

---

## License

MIT
