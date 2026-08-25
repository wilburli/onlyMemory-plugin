/**
 * JSON 文件会话存储
 *
 * 每个会话摘要保存为独立的 JSON 文件。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionSummary } from '../models.js';

export class SessionStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** 保存会话摘要 */
  save(session: SessionSummary): void {
    const filePath = path.join(this.dir, `${session.sessionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  /** 获取会话摘要 */
  get(sessionId: string): SessionSummary | null {
    const filePath = path.join(this.dir, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as SessionSummary;
  }

  /** 列出所有会话 */
  list(): SessionSummary[] {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    return files
      .map((f) => {
        try {
          const data = fs.readFileSync(path.join(this.dir, f), 'utf-8');
          return JSON.parse(data) as SessionSummary;
        } catch {
          return null;
        }
      })
      .filter((s): s is SessionSummary => s != null);
  }
}
