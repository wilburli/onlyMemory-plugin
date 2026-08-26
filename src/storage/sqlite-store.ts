/**
 * SQLite 存储层 - 使用 sql.js（纯 JS SQLite）
 *
 * sql.js 将整个数据库加载到内存中操作，修改后需要保存回磁盘。
 * 本模块封装了自动保存逻辑，确保每次写操作后数据持久化。
 */

import initSqlJs, { type Database } from 'sql.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Memory, MemoryStatus, SessionSummary, MemoryTag, MemoryRelation } from '../models.js';
import { RelationType, generateId } from '../models.js';

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
  pinned        INTEGER DEFAULT 0,
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
  note        TEXT DEFAULT '',
  confidence  REAL DEFAULT 1.0,
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (from_id) REFERENCES memories(id),
  FOREIGN KEY (to_id) REFERENCES memories(id)
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id   TEXT NOT NULL,
  tag         TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id) REFERENCES memories(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_id);

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

    // 兼容旧数据库：添加 pinned 列（已存在则忽略错误）
    try { this.db.run('ALTER TABLE memories ADD COLUMN pinned INTEGER DEFAULT 0'); } catch { /* 列已存在 */ }
    // 兼容旧数据库：memory_relations 添加 note 列
    try { this.db.run("ALTER TABLE memory_relations ADD COLUMN note TEXT DEFAULT ''"); } catch { /* 列已存在 */ }

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
       (id, content, type, entities, importance, embedding, status, pinned,
        access_count, last_accessed, created_at, updated_at, source_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mem.id,
        mem.content,
        mem.type,
        JSON.stringify(mem.entities),
        mem.importance,
        embeddingBlob,
        mem.status,
        mem.pinned ? 1 : 0,
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

  /** 更新记忆内容 */
  updateMemory(id: string, updates: { content?: string; importance?: number; type?: string }): boolean {
    if (!this.db) return false;
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (updates.content !== undefined) { sets.push('content = ?'); params.push(updates.content); }
    if (updates.importance !== undefined) { sets.push('importance = ?'); params.push(updates.importance); }
    if (updates.type !== undefined) { sets.push('type = ?'); params.push(updates.type); }
    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    params.push(id);
    this.db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params);
    const changes = this.db.getRowsModified();
    if (changes > 0) this.markDirty();
    return changes > 0;
  }

  /** 置顶记忆 */
  pinMemory(id: string): boolean {
    if (!this.db) return false;
    this.db.run("UPDATE memories SET pinned = 1, updated_at = datetime('now') WHERE id = ? AND status = 'active'", [id]);
    const changes = this.db.getRowsModified();
    if (changes > 0) this.markDirty();
    return changes > 0;
  }

  /** 取消置顶 */
  unpinMemory(id: string): boolean {
    if (!this.db) return false;
    this.db.run('UPDATE memories SET pinned = 0, updated_at = datetime(?) WHERE id = ?', [new Date().toISOString(), id]);
    const changes = this.db.getRowsModified();
    if (changes > 0) this.markDirty();
    return changes > 0;
  }

  /** 获取所有置顶记忆 ID */
  getPinnedIds(): Set<string> {
    if (!this.db) return new Set();
    const results = this.db.exec("SELECT id FROM memories WHERE pinned = 1 AND status = 'active'");
    if (results.length === 0) return new Set();
    return new Set(results[0].values.map((row: unknown[]) => row[0] as string));
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

  /**
   * 按内容精确查找活跃记忆（用于写入去重）
   * 返回内容完全相同的第一条活跃记忆，没有则返回 null
   */
  findByContent(content: string): Memory | null {
    if (!this.db) return null;
    const results = this.db.exec(
      "SELECT * FROM memories WHERE status = 'active' AND content = ? LIMIT 1",
      [content],
    );
    if (results.length === 0 || results[0].values.length === 0) return null;
    return rowToMemory(results[0].columns, results[0].values[0]);
  }

  /** 按会话 ID 获取属于该会话的活跃记忆 */
  getBySession(sessionId: string): Memory[] {
    if (!this.db) return [];
    const results = this.db.exec(
      "SELECT * FROM memories WHERE status = 'active' AND source_session = ? ORDER BY created_at DESC",
      [sessionId],
    );
    if (results.length === 0) return [];
    return results[0].values.map((row: unknown[]) => rowToMemory(results[0].columns, row));
  }

  /** 获取所有不同会话的 ID（用于展示历史会话列表） */
  getSessionIds(): string[] {
    if (!this.db) return [];
    const results = this.db.exec(
      "SELECT DISTINCT source_session FROM memories WHERE status = 'active' AND source_session IS NOT NULL ORDER BY source_session DESC",
    );
    if (results.length === 0) return [];
    return results[0].values.map((row: unknown[]) => row[0] as string);
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
  // 标签管理
  // ================================================================ //

  /** 给记忆添加标签 */
  addTag(memoryId: string, tag: string): boolean {
    if (!this.db) return false;
    const norm = tag.trim().toLowerCase();
    if (!norm) return false;
    try {
      this.db.run(
        `INSERT OR IGNORE INTO memory_tags (memory_id, tag, created_at)
         VALUES (?, ?, datetime('now'))`,
        [memoryId, norm],
      );
      const changed = this.db.getRowsModified() > 0;
      if (changed) this.markDirty();
      return changed;
    } catch {
      return false;
    }
  }

  /** 移除标签 */
  removeTag(memoryId: string, tag: string): boolean {
    if (!this.db) return false;
    const norm = tag.trim().toLowerCase();
    this.db.run('DELETE FROM memory_tags WHERE memory_id = ? AND tag = ?', [memoryId, norm]);
    const changed = this.db.getRowsModified() > 0;
    if (changed) this.markDirty();
    return changed;
  }

  /** 获取一条记忆的所有标签 */
  getTagsForMemory(memoryId: string): string[] {
    if (!this.db) return [];
    const results = this.db.exec(
      'SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag',
      [memoryId],
    );
    if (results.length === 0) return [];
    return results[0].values.map((row: unknown[]) => row[0] as string);
  }

  /** 按标签查找记忆 ID */
  findMemoryIdsByTag(tag: string): string[] {
    if (!this.db) return [];
    const norm = tag.trim().toLowerCase();
    const results = this.db.exec(
      "SELECT mt.memory_id FROM memory_tags mt JOIN memories m ON m.id = mt.memory_id WHERE mt.tag = ? AND m.status = 'active'",
      [norm],
    );
    if (results.length === 0) return [];
    return results[0].values.map((row: unknown[]) => row[0] as string);
  }

  /** 获取所有已使用的标签（去重排序） */
  getAllTags(): string[] {
    if (!this.db) return [];
    const results = this.db.exec(
      "SELECT DISTINCT mt.tag FROM memory_tags mt JOIN memories m ON m.id = mt.memory_id WHERE m.status = 'active' ORDER BY mt.tag",
    );
    if (results.length === 0) return [];
    return results[0].values.map((row: unknown[]) => row[0] as string);
  }

  /** 批量获取多条记忆的标签（返回 Map） */
  getTagsForMemories(ids: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (!this.db || ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(',');
    const res = this.db.exec(
      `SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders}) ORDER BY tag`,
      ids,
    );
    if (res.length === 0) return result;
    for (const [memId, tag] of res[0].values as [string, string][]) {
      if (!result.has(memId)) result.set(memId, []);
      result.get(memId)!.push(tag);
    }
    return result;
  }

  /** 删除记忆时同步清除其标签 */
  deleteTagsForMemory(memoryId: string): void {
    if (!this.db) return;
    this.db.run('DELETE FROM memory_tags WHERE memory_id = ?', [memoryId]);
    this.markDirty();
  }

  // ================================================================ //
  // 关系管理
  // ================================================================ //

  /** 建立两条记忆的关系 */
  linkMemories(
    fromId: string,
    toId: string,
    relationType: RelationType,
    note: string = '',
    confidence: number = 1.0,
  ): MemoryRelation | null {
    if (!this.db) return null;
    // 检查两条记忆均存在
    const fromOk = this.db.exec("SELECT id FROM memories WHERE id = ? AND status = 'active'", [fromId]);
    const toOk   = this.db.exec("SELECT id FROM memories WHERE id = ? AND status = 'active'", [toId]);
    if (!fromOk.length || !fromOk[0].values.length) return null;
    if (!toOk.length   || !toOk[0].values.length)   return null;

    // 如果相同方向已有相同类型的关系，更新而非重复插入
    const existing = this.db.exec(
      'SELECT id FROM memory_relations WHERE from_id = ? AND to_id = ? AND relation_type = ?',
      [fromId, toId, relationType],
    );
    const now = new Date().toISOString();
    let relId: string;
    if (existing.length && existing[0].values.length) {
      relId = existing[0].values[0][0] as string;
      this.db.run(
        'UPDATE memory_relations SET note = ?, confidence = ? WHERE id = ?',
        [note, confidence, relId],
      );
    } else {
      relId = generateId();
      this.db.run(
        `INSERT INTO memory_relations (id, from_id, to_id, relation_type, note, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [relId, fromId, toId, relationType, note, confidence, now],
      );
    }
    this.markDirty();
    return { id: relId, fromId, toId, relationType, note, confidence, createdAt: now };
  }

  /** 获取一条记忆的所有关联关系（双向） */
  getRelationsForMemory(memoryId: string): MemoryRelation[] {
    if (!this.db) return [];
    const results = this.db.exec(
      `SELECT id, from_id, to_id, relation_type, note, confidence, created_at
       FROM memory_relations
       WHERE from_id = ? OR to_id = ?
       ORDER BY created_at DESC`,
      [memoryId, memoryId],
    );
    if (!results.length) return [];
    return results[0].values.map((row: unknown[]) => ({
      id:           row[0] as string,
      fromId:       row[1] as string,
      toId:         row[2] as string,
      relationType: row[3] as RelationType,
      note:         row[4] as string,
      confidence:   row[5] as number,
      createdAt:    row[6] as string,
    }));
  }

  /** 移除关系 */
  unlinkMemories(fromId: string, toId: string, relationType?: RelationType): number {
    if (!this.db) return 0;
    if (relationType) {
      this.db.run(
        'DELETE FROM memory_relations WHERE from_id = ? AND to_id = ? AND relation_type = ?',
        [fromId, toId, relationType],
      );
    } else {
      this.db.run(
        'DELETE FROM memory_relations WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
        [fromId, toId, toId, fromId],
      );
    }
    const changed = this.db.getRowsModified();
    if (changed > 0) this.markDirty();
    return changed;
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
    pinned: ((obj.pinned as number) ?? 0) === 1,
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
