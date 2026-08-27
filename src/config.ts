/**
 * 插件配置
 *
 * 在 Harness 环境中通过 cordis.yml 配置；
 * 独立使用时通过构造参数配置。
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

/** 插件配置接口 */
export interface MemoryPluginConfig {
  /** 项目标识，不同项目记忆隔离 */
  projectId: string;
  /** 数据存储根目录 */
  dataDir: string;
  /** SQLite 数据库文件名 */
  dbName: string;
  /** 检索返回的最大记忆条数 */
  topK: number;
  /** 上下文注入的 token 预算上限（0 = 不限制） */
  maxContextTokens: number;
  /** 重要性阈值：高于此值的记忆直接入库 */
  importanceThreshold: number;
  /** 衰减半衰期（天） */
  halfLifeDays: number;
  /** Embedding 后端 */
  embeddingBackend: 'none' | 'openai' | 'dashscope' | 'local';
  /** Embedding 模型名称 */
  embeddingModel: string;
  /** Embedding 向量维度 */
  embeddingDim: number;
  /** LLM 摘要后端 */
  summarizerBackend: 'none' | 'openai' | 'dashscope' | 'deepseek';
  /** 活跃记忆上限（0 = 不限制），超限时自动归档低分记忆 */
  maxActiveMemories: number;
}

/** 默认配置 */
export const DEFAULT_CONFIG: MemoryPluginConfig = {
  projectId: 'default',
  dataDir: path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? '.',
    '.onlymem',
  ),
  dbName: 'memory.db',
  topK: 10,
  maxContextTokens: 2000,
  importanceThreshold: 0.5,
  halfLifeDays: 30,
  embeddingBackend: 'none',
  embeddingModel: 'paraphrase-multilingual-MiniLM-L12-v2',
  embeddingDim: 384,
  summarizerBackend: 'none',
  maxActiveMemories: 500,
};

/** 合并配置 */
export function resolveConfig(overrides?: Partial<MemoryPluginConfig>): MemoryPluginConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** 获取项目目录 */
export function getProjectDir(config: MemoryPluginConfig): string {
  return path.join(config.dataDir, config.projectId);
}

/** 获取数据库路径 */
export function getDbPath(config: MemoryPluginConfig): string {
  return path.join(getProjectDir(config), config.dbName);
}

/** 获取会话目录 */
export function getSessionDir(config: MemoryPluginConfig): string {
  return path.join(getProjectDir(config), 'sessions');
}

/** 确保目录存在 */
export function ensureDirs(config: MemoryPluginConfig): void {
  fs.mkdirSync(getProjectDir(config), { recursive: true });
  fs.mkdirSync(getSessionDir(config), { recursive: true });
}
