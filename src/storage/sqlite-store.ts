/**
 * SQLite 存储层 - 使用 sql.js（纯 JS SQLite）
 *
 * sql.js 将整个数据库加载到内存中操作，修改后需要保存回磁盘。
 * 本模块封装了自动保存逻辑，确保每次写操作后数据持久化。
 */

import initSqlJs, { type Database } from 'sql.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Memory, MemoryStatus, SessionSummary } from '../models.js';

/** SQL 初始化脚本 */
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  content       TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'fact',
  entities      TEXT DEFAULT '[]',
  importance    REAL DEFAULT 0.5,
  embedding     BLOB,
  status        TEXT DEFAULT 'active',
  access_count  INTEGER DEFAULT 0,
  last_accessed TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  source_session TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);

CREATE TABLE IF NOT EXISTS memory_relations (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence  REAL DEFAULT 1.0,
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (from_id) REFERENCES memories(id),
  FOREIGN KEY (to_id) REFERENCES memories(id)
);

CREATE TABLE IF NOT EXISTS session_logs (
  session_id   TEXT PRIMARY KEY,
  summary      TEXT,
  end_time     TEXT,
  memory_count INTEGER DEFAULT 0
);
`;

export class SqliteStore {
  private db: Database | null = null;
  private dbPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private needsSave = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** 初始化数据库（异步，因为 sql.js 需要异步加载 WASM） */
  async init(): Promise<void> {
    // 支持自定义 WASM 路径（用于 Harness 安装后定位）
    const wasmPath = process.env.SQL_JS_WASM_PATH;
    const SQL = wasmPath
      ? await initSqlJs({ locateFile: () => wasmPath })
      : await initSqlJs();

    // 如果数据库文件存在，从文件加载
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      // 确保目录存在
      const dir = path.dirname(this.dbPath);
      fs.mkdirSync(dir, { recursive: true });
      this.db = new SQL.Database();
    }

    // 执行初始化 SQL
    this.db.run(INIT_SQL);
    this.save();
  }

  /** 保存数据库到磁盘 */
  private save(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
    this.needsSave = false;
  }

  /** 标记需要保存（延迟批量写入） */
  private markDirty(): void {
    this.needsSave = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 100);
  }

  /** 强制保存 */
  flush(): void {
    if (this.needsSave) this.save();
  }

  /** 关闭数据库 */
  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.flush();
    this.db?.close();
    this.db = null;
  }

  // ================================================================ //
  // 记忆 CRUD
  // ================================================================ //

  /** 插入记忆 */
  insertMemory(mem: Memory): void {
    if (!this.db) throw new Error('Database not initialized');

    const embeddingBlob = mem.embedding
      ? serializeFloat32Array(mem.embedding)
      : null;

    this.db.run(
      `INSERT OR REPLACE INTO memories
       (id, content, type, entities, importance, embedding, status,
        access_count, last_accessed, created_at, updated_at, source_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mem.id,
        mem.content,
        mem.type,
        JSON.stringify(mem.entities),
        mem.importance,
        embeddingBlob,
        mem.status,
        mem.accessCount,
        mem.lastAccessed,
        mem.createdAt,
        mem.updatedAt,
        mem.sourceSession,
      ],
    );
    this.markDirty();
  }

  /** 获取记忆 */
  getMemory(id: string): Memory | null {
    if (!this.db) return null;
    const results = this.db.exec(
      'SELECT * FROM memories WHERE id = ?',
      [id],
    );
    if (results.length === 0 || results[0].values.length === 0) return null;
    return rowToMemory(results[0].columns, results[0].values[0]);
  }

  /** 更新记忆重要度 */
  updateImportance(id: string, importance: number): void {
    if (!this.db) return;
    this.db.run(
      `UPDATE memories SET importance = ?, updated_at = datetime('now') WHERE id = ?`,
      [importance, id],
    );
    this.markDirty();
  }

  /** 增加访问计数 */
  incrementAccessCount(id: string): void {
    if (!this.db) return;
    this.db.run(
      `UPDATE memories SET access_count = access_count + 1,
       last_accessed = datetime('now') WHERE id = ?`,
      [id],
    );
    this.markDirty();
  }

  /** 删除记忆（设为 archived 状态） */
  archiveMemory(id: string): boolean {
    if (!this.db) return false;
    this.db.run(
      `UPDATE memories SET status = 'archived', updated_at = datetime('now') WHERE id = ? AND status = 'active'`,
      [id],
    );
    const changes = this.db.getRowsModified();
    if (changes > 0) this.markDirty();
    return changes > 0;
  }

  /** 删除记忆（真正删除） */
  deleteMemory(id: string): boolean {
    if (!this.db) return false;
    this.db.run('DELETE FROM memories WHERE id = ?', [id]);
    const changes = this.db.getRowsModified();
    if (changes > 0) this.markDirty();
    return changes > 0;
  }

  /** 获取所有活跃记忆（含 embedding） */
  getAllActive(): Memory[] {
    if (!this.db) return [];
    const results = this.db.exec(
      "SELECT * FROM memories WHERE status = 'active' ORDER BY importance DESC",
    );
    if (results.length === 0) return [];
    return results[0].values.map((row: unknown[]) => rowToMemory(results[0].columns, row));
  }

  /** 获取活跃记忆数量 */
  getActiveCount(): number {
    if (!this.db) return 0;
    const results = this.db.exec(
      "SELECT COUNT(*) FROM memories WHERE status = 'active'",
    );
    return results[0]?.values[0]?.[0] as number ?? 0;
  }

  // ================================================================ //
  // 全文搜索
  // ================================================================ //

  /** FTS 搜索（LIKE 降级，中文友好） */
  ftsSearch(query: string, limit: number = 20): Array<[string, number]> {
    if (!this.db) return [];

    // 使用 LIKE 搜索（兼容中文，无需 FTS5 tokenizer）
    const keywords = query.split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => 'content LIKE ?').join(' AND ');
    const params = keywords.map((k) => `%${k}%`);

    const results = this.db.exec(
      `SELECT id, importance FROM memories
       WHERE status = 'active' AND (${conditions})
       ORDER BY importance DESC LIMIT ?`,
      [...params, limit],
    );

    if (results.length === 0) return [];
    return results[0].values.map((row: unknown[]) => [
      row[0] as string,
      row[1] as number,
    ]);
  }

  /** 实体搜索 */
  entitySearch(entities: string[], limit: number = 20): string[] {
    if (!this.db || entities.length === 0) return [];

    const conditions = entities.map(() => 'entities LIKE ?').join(' OR ');
    const params = entities.map((e) => `%${e}%`);

    const results = this.db.exec(
      `SELECT id FROM memories
       WHERE status = 'active' AND (${conditions})
       ORDER BY importance DESC LIMIT ?`,
      [...params, limit],
    );

    if (results.length === 0) return [];
    return results[0].values.map((row: unknown[]) => row[0] as string);
  }

  /** 按重要度获取低分记忆 */
  getLowImportanceMemories(threshold: number): Memory[] {
    if (!this.db) return [];
    const results = this.db.exec(
      `SELECT * FROM memories
       WHERE status = 'active' AND importance < ?
       ORDER BY importance ASC`,
      [threshold],
    );
    if (results.length === 0) return [];
    return results[0].values.map((row: unknown[]) => rowToMemory(results[0].columns, row));
  }

  // ================================================================ //
  // 会话日志
  // ================================================================ //

  saveSessionLog(session: SessionSummary): void {
    if (!this.db) return;
    this.db.run(
      `INSERT OR REPLACE INTO session_logs (session_id, summary, end_time, memory_count)
       VALUES (?, ?, ?, ?)`,
      [session.sessionId, session.summary, session.endTime, session.memoryCount],
    );
    this.markDirty();
  }

  // ================================================================ //
  // 导出
  // ================================================================ //

  /** 导出所有活跃记忆为 JSON 格式 */
  exportAll(): object[] {
    const memories = this.getAllActive();
    return memories.map((m) => ({
      content: m.content,
      type: m.type,
      entities: m.entities,
      importance: m.importance,
      status: m.status,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  }
}

// ================================================================ //
// 辅助函数
// ================================================================ //

/** 将 sql.js 的行结果转换为 Memory 对象 */
function rowToMemory(columns: string[], row: unknown[]): Memory {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = row[i];
  }

  let entities: string[] = [];
  try {
    entities = JSON.parse((obj.entities as string) ?? '[]');
  } catch {
    entities = [];
  }

  let embedding: Float32Array | null = null;
  if (obj.embedding != null) {
    embedding = deserializeFloat32Array(obj.embedding as Uint8Array);
  }

  return {
    id: obj.id as string,
    content: obj.content as string,
    type: (obj.type as Memory['type']) ?? 'fact',
    entities,
    importance: (obj.importance as number) ?? 0.5,
    embedding,
    status: (obj.status as MemoryStatus) ?? 'active',
    accessCount: (obj.access_count as number) ?? 0,
    lastAccessed: (obj.last_accessed as string) ?? new Date().toISOString(),
    createdAt: (obj.created_at as string) ?? new Date().toISOString(),
    updatedAt: (obj.updated_at as string) ?? new Date().toISOString(),
    sourceSession: (obj.source_session as string) ?? null,
  };
}

/** 序列化 Float32Array 为 Uint8Array（存入 SQLite BLOB） */
function serializeFloat32Array(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
}

/** 反序列化 Uint8Array 为 Float32Array（从 SQLite BLOB 读取） */
function deserializeFloat32Array(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}
