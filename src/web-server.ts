/**
 * OnlyMemory Web Server
 *
 * 提供 REST API 和静态前端页面，用于在浏览器中管理记忆。
 * 与 MCP stdio 服务器共享同一个 MemoryEngine 实例。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryEngine } from './engine.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface WebServerOptions {
  engine: MemoryEngine;
  port?: number;
  host?: string;
}

export class WebServer {
  private engine: MemoryEngine;
  private port: number;
  private host: string;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(options: WebServerOptions) {
    this.engine = options.engine;
    this.port = options.port ?? 3456;
    this.host = options.host ?? '127.0.0.1';
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      // 先设置 CORS 头，再处理请求
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      this.handle(req, res).catch((err) => {
        this.json(res, { error: (err as Error).message }, 500);
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.port, this.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  getUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  // ──────────── Request Router ────────────

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const parsedUrl = new URL(rawUrl, `http://${this.host}:${this.port}`);
    const url = parsedUrl.pathname;

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // --- API ---
    if (url.startsWith('/api/')) {
      const path = url.slice(4);

      // GET routes
      if (method === 'GET') {
        if (path === '/memories') return this.getMemories(req, res);
        if (path.startsWith('/memories/')) return this.getMemory(path.slice(10), res);
        if (path === '/stats') return this.getStats(res);
      }

      // POST routes
      if (method === 'POST') {
        const body = await this.readBody(req);
        if (path === '/memories') return this.createMemory(body, res);
        if (path.startsWith('/memories/')) {
          const id = path.slice(10);
          return this.updateMemory(id, body, res);
        }
        if (path.startsWith('/pin/')) return this.pinMemory(path.slice(5), res);
        if (path.startsWith('/unpin/')) return this.unpinMemory(path.slice(7), res);
        if (path.startsWith('/delete/')) return this.deleteMemory(path.slice(8), res);
        if (path === '/forget') return this.forgetMemory(body, res);
      }

      return this.json(res, { error: 'Not Found' }, 404);
    }

    // --- Static files ---
    await this.serveStatic(url, res);
  }

  // ──────────── API Handlers ────────────

  private getMemories(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const rawUrl = req.url ?? '/';
    const params = new URL(rawUrl, `http://${this.host}:${this.port}`).searchParams;
    const type = params.get('type');
    const search = params.get('search');
    const limit = parseInt(params.get('limit') ?? '100', 10);

    let memories: ReturnType<MemoryEngine['getAllMemories']>;

    if (search) {
      const results = this.engine.search(search);
      memories = results.map((r) => r.memory);
    } else {
      memories = this.engine.getAllMemories();
    }

    if (type && type !== 'all') {
      memories = memories.filter((m) => m.type === type);
    }

    // pinned first, then by importance desc
    memories.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.importance - a.importance;
    });

    memories = memories.slice(0, limit);
    this.json(res, { memories, total: memories.length });
  }

  private getMemory(id: string, res: import('node:http').ServerResponse) {
    const mem = this.engine.getMemory(id);
    if (!mem) return this.json(res, { error: 'Not found' }, 404);
    this.json(res, mem);
  }

  private getStats(res: import('node:http').ServerResponse) {
    this.json(res, this.engine.getStats());
  }

  private async createMemory(body: Record<string, unknown>, res: import('node:http').ServerResponse) {
    const content = body.content as string;
    if (!content) return this.json(res, { error: 'content is required' }, 400);
    const mem = await this.engine.remember(content, (body.importance as number) ?? 1.0);
    this.json(res, mem, 201);
  }

  private updateMemory(id: string, body: Record<string, unknown>, res: import('node:http').ServerResponse) {
    const updates: { content?: string; importance?: number; type?: string } = {};
    if (body.content !== undefined) updates.content = body.content as string;
    if (body.importance !== undefined) updates.importance = body.importance as number;
    if (body.type !== undefined) updates.type = body.type as string;
    const ok = this.engine.updateMemory(id, updates);
    if (!ok) return this.json(res, { error: 'Not found' }, 404);
    this.json(res, { ok: true });
  }

  private pinMemory(id: string, res: import('node:http').ServerResponse) {
    const ok = this.engine.pinMemory(id);
    if (!ok) return this.json(res, { error: 'Not found' }, 404);
    this.json(res, { ok: true });
  }

  private unpinMemory(id: string, res: import('node:http').ServerResponse) {
    const ok = this.engine.unpinMemory(id);
    if (!ok) return this.json(res, { error: 'Not found' }, 404);
    this.json(res, { ok: true });
  }

  private deleteMemory(id: string, res: import('node:http').ServerResponse) {
    const ok = this.engine.deleteMemory(id);
    if (!ok) return this.json(res, { error: 'Not found' }, 404);
    this.json(res, { ok: true });
  }

  private async forgetMemory(body: Record<string, unknown>, res: import('node:http').ServerResponse) {
    const query = body.query as string;
    if (!query) return this.json(res, { error: 'query is required' }, 400);
    const count = await this.engine.forget(query);
    this.json(res, { deleted: count });
  }

  // ──────────── Helpers ────────────

  private readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private json(res: import('node:http').ServerResponse, data: unknown, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private async serveStatic(urlPath: string, res: import('node:http').ServerResponse) {
    let filePath = urlPath === '/' ? '/index.html' : urlPath;
    filePath = filePath.replace(/\.\./g, '');

    const fullPath = join(__dirname, '..', 'web', filePath);
    try {
      const content = await readFile(fullPath);
      const ext = extname(fullPath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }
}
