/**
 * MCP 记忆服务器
 *
 * 将 MemoryEngine 包装为 MCP stdio 服务器，
 * 供 DeepSeek Harness 通过 dsh-mcp-client 调用。
 *
 * 启动方式：
 *   node bin/only-memory.mjs
 *
 * Harness 配置 (cordis-patch.yml)：
 *   - insert:
 *       - id: memory-deepseek
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config:
 *           serverName: only_memory
 *           transport: stdio
 *           command: node
 *           args: [/absolute/path/to/bin/only-memory.mjs]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryEngine } from './engine.js';
import type { MemoryPluginConfig } from './config.js';

export async function startMcpServer(configOverrides?: Partial<MemoryPluginConfig>): Promise<void> {
  const engine = new MemoryEngine(configOverrides);
  await engine.init();

  const server = new McpServer(
    { name: 'only-memory', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Long-term memory for DeepSeek Harness. ' +
        'Use remember to store facts, forget to remove outdated info, ' +
        'search to recall relevant memories, and stats to check memory status.',
    },
  );

  // ================================================================ //
  // 工具: remember - 记住一条信息
  // ================================================================ //
  server.tool(
    'remember',
    'Remember an important fact, preference, or event for future conversations. ' +
    'Use this when the user asks you to remember something or when you identify important context.',
    {
      content: z.string().describe('The fact or information to remember'),
      importance: z.number().min(0).max(1).default(1.0).describe('Importance score 0-1 (default 1.0)'),
    },
    async ({ content, importance }) => {
      engine.remember(content, importance);
      return {
        content: [{ type: 'text', text: `Remembered: ${content}` }],
      };
    },
  );

  // ================================================================ //
  // 工具: forget - 遗忘信息
  // ================================================================ //
  server.tool(
    'forget',
    'Delete memories related to a query. Use this when the user asks you to forget something ' +
    'or when information becomes outdated.',
    {
      query: z.string().describe('Keywords describing what to forget'),
    },
    async ({ query }) => {
      const deleted = engine.forget(query);
      return {
        content: [{ type: 'text', text: `Deleted ${deleted} related memories for: ${query}` }],
      };
    },
  );

  // ================================================================ //
  // 工具: search - 搜索记忆
  // ================================================================ //
  server.tool(
    'search',
    'Search stored memories for relevant information. Use this when historical context ' +
    'may be helpful for the current conversation.',
    {
      query: z.string().describe('Search keywords'),
      limit: z.number().int().min(1).max(20).default(5).describe('Max results (default 5)'),
    },
    async ({ query, limit }) => {
      const results = engine.search(query);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No relevant memories found.' }] };
      }

      const lines = results.slice(0, limit).map((r, i) => {
        const pct = Math.round(r.score * 100);
        return `${i + 1}. [${r.memory.type}] ${r.memory.content} (relevance: ${pct}%)`;
      });

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    },
  );

  // ================================================================ //
  // 工具: stats - 记忆库状态
  // ================================================================ //
  server.tool(
    'stats',
    'Get memory storage statistics: number of active memories, project, and storage path.',
    {},
    async () => {
      const s = engine.getStats();
      const text = [
        `Active memories: ${s.active}`,
        `Project: ${s.projectId}`,
        `Database: ${s.dbPath}`,
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  // ================================================================ //
  // 工具: list_memories - 列出所有记忆
  // ================================================================ //
  server.tool(
    'list_memories',
    'List all stored memories with their type, content, and importance score.',
    {
      limit: z.number().int().min(1).max(50).default(20).describe('Max memories to list (default 20)'),
    },
    async ({ limit }) => {
      const memories = engine.getAllMemories();
      if (memories.length === 0) {
        return { content: [{ type: 'text', text: 'No memories stored yet.' }] };
      }

      const lines = memories.slice(0, limit).map((m) => {
        return `- [${m.type}] ${m.content} (importance: ${m.importance.toFixed(2)})`;
      });
      lines.unshift(`Total: ${memories.length} memories (showing ${Math.min(limit, memories.length)}):\n`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ================================================================ //
  // 工具: export_memories - 导出记忆
  // ================================================================ //
  server.tool(
    'export_memories',
    'Export all memories to a JSON file for backup or migration.',
    {
      path: z.string().describe('Absolute file path to export to'),
    },
    async ({ path: filePath }) => {
      const count = engine.exportToFile(filePath);
      return {
        content: [{ type: 'text', text: `Exported ${count} memories to ${filePath}` }],
      };
    },
  );

  // ================================================================ //
  // 工具: import_memories - 导入记忆
  // ================================================================ //
  server.tool(
    'import_memories',
    'Import memories from a previously exported JSON file.',
    {
      path: z.string().describe('Absolute file path to import from'),
    },
    async ({ path: filePath }) => {
      const count = engine.importFromFile(filePath);
      return {
        content: [{ type: 'text', text: `Imported ${count} memories from ${filePath}` }],
      };
    },
  );

  // ---- 启动 stdio 传输 ----
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 优雅关闭
  const shutdown = async () => {
    engine.close();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
