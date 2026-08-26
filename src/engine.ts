/**
 * MemoryEngine - 记忆系统主引擎
 *
 * 整合所有子模块，提供完整的记忆管理能力。
 * 可独立使用，也可通过 Cordis 插件入口集成到 Harness。
 */

import type { Memory, SessionSummary, RetrievalResult, CreateMemoryInput } from './models.js';
import { MemoryType, MemoryStatus, createMemory, generateId } from './models.js';
import type { MemoryPluginConfig } from './config.js';
import { resolveConfig, ensureDirs, getDbPath, getSessionDir } from './config.js';
import { SqliteStore } from './storage/sqlite-store.js';
import { LocalVectorStore } from './storage/vector-store.js';
import { SessionStore } from './storage/session-store.js';
import { EntityExtractor } from './encoder/entity-extractor.js';
import { ImportanceScorer } from './scorer/importance.js';
import { MultiRecallRetriever } from './retriever/multi-recall.js';
import { DecayManager } from './maintenance/decay.js';
import { MemoryMerger } from './maintenance/merger.js';
import { MemoryCleaner } from './maintenance/cleaner.js';
import * as fs from 'node:fs';

const EXPORT_VERSION = '1.0';

export class MemoryEngine {
  private config: MemoryPluginConfig;
  private store!: SqliteStore;
  private vectorStore: LocalVectorStore;
  private sessionStore!: SessionStore;
  private extractor: EntityExtractor;
  private scorer: ImportanceScorer;
  private retriever!: MultiRecallRetriever;
  private decay: DecayManager;
  private merger: MemoryMerger;
  private cleaner: MemoryCleaner;

  private currentSessionId: string | null = null;
  private sessionUserMsgs: string[] = [];
  private sessionAssistantMsgs: string[] = [];
  private initialized = false;

  constructor(config?: Partial<MemoryPluginConfig>) {
    this.config = resolveConfig(config);
    this.vectorStore = new LocalVectorStore();
    this.extractor = new EntityExtractor();
    this.scorer = new ImportanceScorer(this.extractor);
    this.decay = new DecayManager(this.config.halfLifeDays);
    this.merger = new MemoryMerger();
    this.cleaner = new MemoryCleaner(0.1);
  }

  /** 异步初始化（sql.js 需要异步加载 WASM） */
  async init(): Promise<void> {
    if (this.initialized) return;

    ensureDirs(this.config);

    this.store = new SqliteStore(getDbPath(this.config));
    await this.store.init();

    this.sessionStore = new SessionStore(getSessionDir(this.config));
    this.retriever = new MultiRecallRetriever(
      this.config,
      this.store,
      this.vectorStore,
      this.extractor,
    );

    // 加载向量索引
    this.reloadVectors();
    this.initialized = true;
  }

  // ================================================================ //
  // 核心接口
  // ================================================================ //

  /** 处理用户消息：检索相关记忆，返回注入到 system prompt 的记忆文本 */
  onUserMessage(msg: string): string {
    this.ensureInitialized();
    if (!this.currentSessionId) this.startSession();
    this.sessionUserMsgs.push(msg);
    return this.retriever.retrieveContextText(msg);
  }

  /** 对话结束后处理：提取新信息、评分、入库 */
  onAssistantMessage(msg: string, userMsg: string = ''): void {
    this.ensureInitialized();
    this.sessionAssistantMsgs.push(msg);
    this.extractAndStore(userMsg, msg);
  }

  /** 显式指令：强制记住一条事实 */
  remember(fact: string, importance: number = 1.0): void {
    this.ensureInitialized();
    const entities = this.extractor.extract(fact);
    const mem = createMemory({
      content: fact,
      type: MemoryType.Fact,
      entities,
      importance,
      embedding: null,
      sourceSession: this.currentSessionId,
    });
    this.store.insertMemory(mem);
  }

  /** 按关键词删除相关记忆 */
  forget(query: string): number {
    this.ensureInitialized();
    let deleted = 0;

    // FTS 搜索
    const ftsResults = this.store.ftsSearch(query, 50);
    for (const [id] of ftsResults) {
      if (this.store.deleteMemory(id)) deleted++;
    }

    // 实体搜索
    const entities = this.extractor.extract(query);
    if (entities.length > 0) {
      const entityResults = this.store.entitySearch(entities, 50);
      for (const id of entityResults) {
        if (this.store.deleteMemory(id)) deleted++;
      }
    }

    return deleted;
  }

  /** 搜索记忆 */
  search(query: string): RetrievalResult[] {
    this.ensureInitialized();
    return this.retriever.retrieve(query);
  }

  /** 获取单条记忆详情 */
  getMemory(id: string): Memory | null {
    this.ensureInitialized();
    return this.store.getMemory(id);
  }

  /** 更新记忆内容/重要度/类型 */
  updateMemory(id: string, updates: { content?: string; importance?: number; type?: string }): boolean {
    this.ensureInitialized();
    return this.store.updateMemory(id, updates);
  }

  /** 置顶记忆（防止衰减和清理） */
  pinMemory(id: string): boolean {
    this.ensureInitialized();
    return this.store.pinMemory(id);
  }

  /** 取消置顶 */
  unpinMemory(id: string): boolean {
    this.ensureInitialized();
    return this.store.unpinMemory(id);
  }

  /** 按 ID 删除单条记忆 */
  deleteMemory(id: string): boolean {
    this.ensureInitialized();
    return this.store.deleteMemory(id);
  }

  /** 获取所有活跃记忆 */
  getAllMemories(): Memory[] {
    this.ensureInitialized();
    return this.store.getAllActive();
  }

  /** 获取统计信息 */
  getStats(): { active: number; dbPath: string; projectId: string } {
    this.ensureInitialized();
    return {
      active: this.store.getActiveCount(),
      dbPath: getDbPath(this.config),
      projectId: this.config.projectId,
    };
  }

  // ================================================================ //
  // 会话管理
  // ================================================================ //

  startSession(sessionId?: string): string {
    this.currentSessionId = sessionId ?? generateId();
    this.sessionUserMsgs = [];
    this.sessionAssistantMsgs = [];
    return this.currentSessionId;
  }

  endSession(summary?: string): void {
    if (!this.currentSessionId) return;

    if (summary && this.sessionStore) {
      const sessionSummary: SessionSummary = {
        sessionId: this.currentSessionId,
        summary,
        endTime: new Date().toISOString(),
        memoryCount: this.sessionUserMsgs.length,
      };
      this.sessionStore.save(sessionSummary);
      this.store.saveSessionLog(sessionSummary);
    }

    this.runMaintenance();
    this.currentSessionId = null;
    this.sessionUserMsgs = [];
    this.sessionAssistantMsgs = [];
  }

  // ================================================================ //
  // 导入导出
  // ================================================================ //

  /** 导出记忆到 JSON 文件 */
  exportToFile(filePath: string): number {
    this.ensureInitialized();
    const memories = this.store.exportAll();
    const data = {
      version: EXPORT_VERSION,
      projectId: this.config.projectId,
      exportedAt: new Date().toISOString(),
      count: memories.length,
      memories,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return memories.length;
  }

  /** 从 JSON 文件导入记忆 */
  importFromFile(filePath: string): number {
    this.ensureInitialized();
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    const list: object[] = Array.isArray(data) ? data : (data.memories ?? []);
    let imported = 0;

    for (const item of list) {
      const entry = item as Record<string, unknown>;
      const content = (entry.content as string) ?? '';
      if (!content) continue;

      this.remember(
        content,
        typeof entry.importance === 'number' ? entry.importance : 0.5,
      );
      imported++;
    }

    return imported;
  }

  // ================================================================ //
  // 生命周期
  // ================================================================ //

  close(): void {
    if (this.currentSessionId) this.endSession();
    this.store?.close();
    this.initialized = false;
  }

  // ================================================================ //
  // 内部方法
  // ================================================================ //

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'MemoryEngine 未初始化。请先调用 await engine.init()。',
      );
    }
  }

  private reloadVectors(): void {
    const memories = this.store.getAllActive();
    const entries = memories
      .filter((m) => m.embedding != null)
      .map((m) => ({ id: m.id, embedding: m.embedding! }));
    this.vectorStore.load(entries);
  }

  private extractAndStore(userMsg: string, assistantMsg: string): void {
    // MVP 模式：规则提取（不依赖 LLM）
    const text = userMsg || assistantMsg;
    if (text.length < 5) return;

    // 检查是否包含值得记忆的信息
    const scoreResult = this.scorer.score(text, MemoryType.Fact);
    if (scoreResult.score < this.config.importanceThreshold) return;

    const entities = this.extractor.extract(text);
    const mem = createMemory({
      content: text,
      type: this.inferType(text),
      entities,
      importance: scoreResult.score,
      embedding: null,
      sourceSession: this.currentSessionId,
    });

    this.store.insertMemory(mem);
  }

  private inferType(text: string): MemoryType {
    if (/喜欢|偏好|prefer|like|习惯|总是/i.test(text)) return MemoryType.Preference;
    if (/做了|去了|参加|买了|happened|visited|attended/i.test(text)) return MemoryType.Event;
    if (/每次|经常|从不|usually|always|never/i.test(text)) return MemoryType.Behavior;
    return MemoryType.Fact;
  }

  private runMaintenance(): void {
    try {
      this.decay.applyDecay(this.store);
      this.merger.merge(this.store);
      this.cleaner.clean(this.store);
      this.store.flush();
    } catch {
      // 维护失败不影响主流程
    }
  }
}
