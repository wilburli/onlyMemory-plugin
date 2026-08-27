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

  // ================================================================ //
  // 工具: run_maintenance - 手动触发记忆库维护
  // ================================================================ //
  server.tool(
    'run_maintenance',
    'Run memory maintenance: apply time decay, merge similar memories, clean low-importance ones, enforce capacity limit. Returns stats.',
    {},
    async () => {
      const result = engine.runMaintenanceNow();
      const lines = [
        'Memory maintenance completed:',
        `  Decayed: ${result.decayed} memories`,
        `  Merged:  ${result.merged} duplicates`,
        `  Cleaned: ${result.cleaned} low-importance`,
        `  Evicted: ${result.evicted} over-capacity`,
        `  Active:  ${result.active} memories remaining`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ================================================================ //
  // 工具: summarize_memories - 摘要压缩记忆
  // ================================================================ //
  server.tool(
    'summarize_memories',
    'Compress related memories into concise summaries using LLM. ' +
    'Groups memories by shared entities and summarizes each group into one memory. ' +
    'Original memories are archived. Requires summarizer backend to be configured.',
    {
      max_groups: z.number().int().min(1).max(10).default(3).describe('Max number of groups to summarize (default 3)'),
    },
    async ({ max_groups }) => {
      if (!engine.hasSummarizer()) {
        return { content: [{ type: 'text', text: 'Summarizer is not configured. Set summarizerBackend to "openai", "dashscope", or "deepseek" and provide the corresponding API key.' }] };
      }
      try {
        const result = await engine.summarizeMemories(max_groups);
        if (result.summarized === 0) {
          return { content: [{ type: 'text', text: 'No groups large enough to summarize (need at least 3 related memories per group).' }] };
        }
        const lines = [
          'Memory summarization completed:',
          `  Groups processed: ${result.groups}`,
          `  Summaries created: ${result.summarized}`,
          `  Memories archived: ${result.archived}`,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Summarization failed: ${(err as Error).message}` }] };
      }
    },
  );

  // ================================================================ //
  // 工具: export_memories_jsonl - JSONL 导出
  // ================================================================ //
  server.tool(
    'export_memories_jsonl',
    'Export all memories to a JSONL file (one JSON object per line). Better for large datasets and streaming.',
    {
      path: z.string().describe('Absolute file path to export to'),
    },
    async ({ path: filePath }) => {
      const count = engine.exportToJsonl(filePath);
      return { content: [{ type: 'text', text: `Exported ${count} memories to ${filePath} (JSONL format)` }] };
    },
  );

  // ================================================================ //
  // 工具: import_memories_jsonl - JSONL 导入
  // ================================================================ //
  server.tool(
    'import_memories_jsonl',
    'Import memories from a JSONL file (one JSON object per line).',
    {
      path: z.string().describe('Absolute file path to import from'),
    },
    async ({ path: filePath }) => {
      const count = await engine.importFromJsonl(filePath);
      return { content: [{ type: 'text', text: `Imported ${count} memories from ${filePath} (JSONL format)` }] };
    },
  );

  // ================================================================ //
  // 工具: list_sessions - 查看历史会话
  // ================================================================ //
  server.tool(
    'list_sessions',
    'List all stored session IDs with metadata. Use this to find sessions and view their memories.',
    {
      limit: z.number().int().min(1).max(50).default(20).describe('Max sessions to list (default 20)'),
    },
    async ({ limit }) => {
      const sessionIds = engine.getSessionIds();
      if (sessionIds.length === 0) {
        return { content: [{ type: 'text', text: 'No sessions found.' }] };
      }
      const currentSid = engine.getCurrentSessionId();
      const lines = sessionIds.slice(0, limit).map((sid) => {
        const current = sid === currentSid ? ' (current)' : '';
        return `- ${sid}${current}`;
      });
      lines.unshift(`Total: ${sessionIds.length} sessions (showing ${Math.min(limit, sessionIds.length)}):\n`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ================================================================ //
  // 工具: get_session_memories - 查看指定会话的记忆
  // ================================================================ //
  server.tool(
    'get_session_memories',
    'Get all memories that were created during a specific session. Use list_sessions first to find session IDs.',
    {
      session_id: z.string().describe('The session ID to get memories for'),
      limit: z.number().int().min(1).max(50).default(20).describe('Max memories to return (default 20)'),
    },
    async ({ session_id, limit }) => {
      const memories = engine.getMemoriesBySession(session_id);
      if (memories.length === 0) {
        return { content: [{ type: 'text', text: `No memories found for session: ${session_id}` }] };
      }
      const lines = memories.slice(0, limit).map((m) => {
        const pin = m.pinned ? ' 📌' : '';
        return `- [${m.type}] ${m.content} (importance: ${m.importance.toFixed(2)}, id: ${m.id})${pin}`;
      });
      lines.unshift(`Session ${session_id}: ${memories.length} memories (showing ${Math.min(limit, memories.length)}):\n`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ================================================================ //
  // 工具: memory_health - 记忆库健康报告
  // ================================================================ //
  server.tool(
    'memory_health',
    'Get a comprehensive health report of the memory store: counts by status, importance distribution, ' +
    'least accessed memories, tag/relation stats, and configuration overview.',
    {},
    async () => {
      const report = engine.getHealthReport();
      const lines = [
        '=== Memory Health Report ===',
        '',
        `Active:   ${report.active}`,
        `Archived: ${report.archived}`,
        `Pinned:   ${report.pinned}`,
        '',
        'Importance Distribution:',
        `  High (≥0.7):   ${report.importance.high}`,
        `  Medium (0.4-0.7): ${report.importance.medium}`,
        `  Low (<0.4):    ${report.importance.low}`,
        `  Average:       ${report.importance.avg.toFixed(3)}`,
        '',
        `Tags:      ${report.tags}`,
        `Relations: ${report.relations}`,
        `Sessions:  ${report.sessions}`,
        '',
        'Configuration:',
        `  Max active memories: ${report.config.maxActiveMemories}`,
        `  Max context tokens:  ${report.config.maxContextTokens}`,
        `  Summarizer:  ${report.config.summarizerEnabled ? 'enabled' : 'disabled'}`,
        `  Embedding:   ${report.config.embeddingEnabled ? 'enabled' : 'disabled'}`,
      ];
      if (report.leastAccessed.length > 0) {
        lines.push('', 'Least Accessed Memories (Top 10):');
        for (const m of report.leastAccessed) {
          lines.push(`  [${m.accessCount}x] ${m.content} (imp: ${m.importance.toFixed(2)}, id: ${m.id})`);
        }
      }
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
