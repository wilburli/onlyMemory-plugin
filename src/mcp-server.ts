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
import { RelationType } from './models.js';

export async function startMcpServer(
  configOverrides?: Partial<MemoryPluginConfig>,
  externalEngine?: MemoryEngine,
  webUrl?: string,
): Promise<void> {
  const engine = externalEngine ?? new MemoryEngine(configOverrides);
  if (!externalEngine) await engine.init();

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
      await engine.remember(content, importance);
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
      const results = await engine.search(query);
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
      const lines = [
        `Active memories: ${s.active}`,
        `Project: ${s.projectId}`,
        `Database: ${s.dbPath}`,
      ];
      if (webUrl) lines.push(`Web UI: ${webUrl}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ================================================================ //
  // 工具: get_memory - 查看单条记忆详情
  // ================================================================ //
  server.tool(
    'get_memory',
    'Get full details of a specific memory by its ID, including content, type, importance, entities, and timestamps.',
    {
      id: z.string().describe('The memory ID to look up'),
    },
    async ({ id }) => {
      const mem = engine.getMemory(id);
      if (!mem) {
        return { content: [{ type: 'text', text: `Memory not found: ${id}` }] };
      }
      const lines = [
        `ID: ${mem.id}`,
        `Content: ${mem.content}`,
        `Type: ${mem.type}`,
        `Importance: ${mem.importance.toFixed(2)}`,
        `Pinned: ${mem.pinned ? 'yes' : 'no'}`,
        `Entities: ${mem.entities.join(', ') || 'none'}`,
        `Access count: ${mem.accessCount}`,
        `Created: ${mem.createdAt}`,
        `Updated: ${mem.updatedAt}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ================================================================ //
  // 工具: update_memory - 编辑记忆内容
  // ================================================================ //
  server.tool(
    'update_memory',
    'Update an existing memory\'s content, importance, or type. Use this to correct mistakes or refine stored information.',
    {
      id: z.string().describe('The memory ID to update'),
      content: z.string().optional().describe('New content text'),
      importance: z.number().min(0).max(1).optional().describe('New importance score 0-1'),
      type: z.enum(['fact', 'preference', 'event', 'behavior']).optional().describe('New memory type'),
    },
    async ({ id, content, importance, type }) => {
      const updates: { content?: string; importance?: number; type?: string } = {};
      if (content !== undefined) updates.content = content;
      if (importance !== undefined) updates.importance = importance;
      if (type !== undefined) updates.type = type;

      const ok = engine.updateMemory(id, updates);
      if (!ok) {
        return { content: [{ type: 'text', text: `Failed to update memory: ${id} (not found or no changes)` }] };
      }
      return { content: [{ type: 'text', text: `Updated memory ${id}` }] };
    },
  );

  // ================================================================ //
  // 工具: pin_memory - 置顶记忆
  // ================================================================ //
  server.tool(
    'pin_memory',
    'Pin a memory to protect it from time decay and automatic cleanup. Pinned memories are always preserved.',
    {
      id: z.string().describe('The memory ID to pin'),
    },
    async ({ id }) => {
      const ok = engine.pinMemory(id);
      if (!ok) {
        return { content: [{ type: 'text', text: `Failed to pin memory: ${id} (not found)` }] };
      }
      return { content: [{ type: 'text', text: `Pinned memory ${id}` }] };
    },
  );

  // ================================================================ //
  // 工具: unpin_memory - 取消置顶
  // ================================================================ //
  server.tool(
    'unpin_memory',
    'Unpin a previously pinned memory, allowing it to be affected by time decay and cleanup again.',
    {
      id: z.string().describe('The memory ID to unpin'),
    },
    async ({ id }) => {
      const ok = engine.unpinMemory(id);
      if (!ok) {
        return { content: [{ type: 'text', text: `Failed to unpin memory: ${id} (not found)` }] };
      }
      return { content: [{ type: 'text', text: `Unpinned memory ${id}` }] };
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
        const pin = m.pinned ? ' 📌' : '';
        return `- [${m.type}] ${m.content} (importance: ${m.importance.toFixed(2)}, id: ${m.id})${pin}`;
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
      const count = await engine.importFromFile(filePath);
      return {
        content: [{ type: 'text', text: `Imported ${count} memories from ${filePath}` }],
      };
    },
  );

  // ================================================================ //
  // 工具: add_tag - 给记忆添加标签
  // ================================================================ //
  server.tool(
    'add_tag',
    'Add a custom tag to a memory for classification. Tags are lowercase and trimmed automatically. ' +
    'Use this to categorize memories (e.g., "work", "personal", "important", "project-x").',
    {
      id:  z.string().describe('The memory ID to tag'),
      tag: z.string().describe('Tag name (e.g. "work", "personal", "important")'),
    },
    async ({ id, tag }) => {
      const mem = engine.getMemory(id);
      if (!mem) return { content: [{ type: 'text', text: `Memory not found: ${id}` }] };
      const ok = engine.addTag(id, tag);
      const norm = tag.trim().toLowerCase();
      if (!ok) return { content: [{ type: 'text', text: `Tag "${norm}" already exists on memory ${id}` }] };
      return { content: [{ type: 'text', text: `Added tag "${norm}" to memory ${id}` }] };
    },
  );

  // ================================================================ //
  // 工具: remove_tag - 移除标签
  // ================================================================ //
  server.tool(
    'remove_tag',
    'Remove a tag from a memory.',
    {
      id:  z.string().describe('The memory ID'),
      tag: z.string().describe('Tag name to remove'),
    },
    async ({ id, tag }) => {
      const ok = engine.removeTag(id, tag);
      if (!ok) return { content: [{ type: 'text', text: `Tag "${tag.trim().toLowerCase()}" not found on memory ${id}` }] };
      return { content: [{ type: 'text', text: `Removed tag "${tag.trim().toLowerCase()}" from memory ${id}` }] };
    },
  );

  // ================================================================ //
  // 工具: filter_by_tag - 按标签列出记忆
  // ================================================================ //
  server.tool(
    'filter_by_tag',
    'List all memories that have a specific tag. Use this to retrieve categorized memories.',
    {
      tag:   z.string().describe('Tag name to filter by'),
      limit: z.number().int().min(1).max(50).default(20).describe('Max results (default 20)'),
    },
    async ({ tag, limit }) => {
      const memories = engine.filterByTag(tag);
      if (memories.length === 0) {
        return { content: [{ type: 'text', text: `No memories found with tag "${tag.trim().toLowerCase()}"` }] };
      }
      const lines = memories.slice(0, limit).map((m) => {
        const pin = m.pinned ? ' 📌' : '';
        const tags = m.tags?.length ? ` [tags: ${m.tags.join(', ')}]` : '';
        return `- [${m.type}] ${m.content} (importance: ${m.importance.toFixed(2)}, id: ${m.id})${pin}${tags}`;
      });
      lines.unshift(`Found ${memories.length} memories with tag "${tag.trim().toLowerCase()}" (showing ${Math.min(limit, memories.length)}):\n`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ================================================================ //
  // 工具: link_memories - 建立记忆关系
  // ================================================================ //
  server.tool(
    'link_memories',
    'Create a directional relationship between two memories. ' +
    'Relation types: contradicts (conflicting info), supports (corroborating info), updates (newer supersedes older), relates (general association). ' +
    'Use this to mark when a new memory contradicts or updates an existing one.',
    {
      from_id:       z.string().describe('Source memory ID'),
      to_id:         z.string().describe('Target memory ID'),
      relation_type: z.enum(['contradicts', 'supports', 'updates', 'relates']).describe('Type of relationship'),
      note:          z.string().default('').describe('Optional note explaining the relationship'),
      confidence:    z.number().min(0).max(1).default(1.0).describe('Confidence score 0-1 (default 1.0)'),
    },
    async ({ from_id, to_id, relation_type, note, confidence }) => {
      const relType = relation_type as RelationType;
      const rel = engine.linkMemories(from_id, to_id, relType, note, confidence);
      if (!rel) {
        return { content: [{ type: 'text', text: `Failed to link: one or both memory IDs not found (${from_id}, ${to_id})` }] };
      }
      return {
        content: [{ type: 'text', text: `Linked memories:\n  [${from_id}] --${relation_type}--> [${to_id}]${note ? `\n  Note: ${note}` : ''}` }],
      };
    },
  );

  // ================================================================ //
  // 工具: get_links - 查看记忆关系
  // ================================================================ //
  server.tool(
    'get_links',
    'Get all relationships associated with a memory (both incoming and outgoing). ' +
    'Useful for understanding how a memory connects to others.',
    {
      id: z.string().describe('The memory ID to get relationships for'),
    },
    async ({ id }) => {
      const mem = engine.getMemory(id);
      if (!mem) return { content: [{ type: 'text', text: `Memory not found: ${id}` }] };
      const links = engine.getLinksForMemory(id);
      if (links.length === 0) {
        return { content: [{ type: 'text', text: `No relationships found for memory ${id}` }] };
      }
      const lines = links.map((l) => {
        const dir = l.fromId === id ? '→' : '←';
        const other = l.fromId === id ? l.toContent : l.fromContent;
        const otherId = l.fromId === id ? l.toId : l.fromId;
        const conf = l.confidence < 1 ? ` (confidence: ${l.confidence.toFixed(2)})` : '';
        const note = l.note ? ` | Note: ${l.note}` : '';
        return `  ${dir} [${l.relationType}] "${other}" (id: ${otherId})${conf}${note}`;
      });
      lines.unshift(`Relationships for memory "${mem.content}" (id: ${id}):\n`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
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
