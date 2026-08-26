/**
 * 数据模型 - 记忆系统核心类型定义
 */

/** 记忆类型 */
export enum MemoryType {
  /** 事实性记忆 */
  Fact = 'fact',
  /** 偏好性记忆 */
  Preference = 'preference',
  /** 事件性记忆 */
  Event = 'event',
  /** 行为模式记忆 */
  Behavior = 'behavior',
}

/** 记忆状态 */
export enum MemoryStatus {
  Active = 'active',
  Archived = 'archived',
  Deleted = 'deleted',
}

/** 关系类型 */
export enum RelationType {
  Contradicts = 'contradicts',
  Supports = 'supports',
  Updates = 'updates',
  Relates = 'relates',
}

/** 记忆条目 */
export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  entities: string[];
  importance: number;       // 0.0 ~ 1.0
  embedding: Float32Array | null;
  status: MemoryStatus;
  pinned: boolean;
  accessCount: number;
  lastAccessed: string;     // ISO datetime
  createdAt: string;        // ISO datetime
  updatedAt: string;        // ISO datetime
  sourceSession: string | null;
  tags?: string[];          // 运行时填充（不存入 memories 表）
}

/** 标签条目 */
export interface MemoryTag {
  memoryId: string;
  tag: string;
  createdAt: string;
}

/** 记忆关系条目 */
export interface MemoryRelation {
  id: string;
  fromId: string;
  toId: string;
  relationType: RelationType;
  note: string;       // 关系备注（可为空）
  confidence: number; // 0.0 ~ 1.0
  createdAt: string;
}

/** 会话摘要 */
export interface SessionSummary {
  sessionId: string;
  summary: string;
  endTime: string;
  memoryCount: number;
}

/** 检索结果 */
export interface RetrievalResult {
  memory: Memory;
  score: number;
  source: 'semantic' | 'fts' | 'entity' | 'importance' | 'time';
}

/** 创建记忆的参数 */
export interface CreateMemoryInput {
  content: string;
  type: MemoryType;
  entities: string[];
  importance: number;
  embedding: Float32Array | null;
  sourceSession?: string | null;
}

/** 生成唯一 ID */
export function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${ts}-${rand}`;
}

/** 创建新记忆对象 */
export function createMemory(input: CreateMemoryInput): Memory {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    content: input.content,
    type: input.type,
    entities: input.entities,
    importance: Math.min(1.0, Math.max(0.0, input.importance)),
    embedding: input.embedding,
    status: MemoryStatus.Active,
    pinned: false,
    accessCount: 0,
    lastAccessed: now,
    createdAt: now,
    updatedAt: now,
    sourceSession: input.sourceSession ?? null,
  };
}
