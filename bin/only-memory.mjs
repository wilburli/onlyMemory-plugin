#!/usr/bin/env node
/**
 * OnlyMemory MCP Server - 启动入口
 *
 * Harness 通过 stdio 启动此进程，自动发现记忆工具。
 * 支持从任何位置调用，自动解析包目录。
 *
 * 环境变量配置（可选）：
 *   ONLYMEM_PROJECT    - 项目标识（默认 "default"）
 *   ONLYMEM_DATA_DIR   - 数据目录（默认 ~/.onlymem）
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..');

// sql.js 需要定位 WASM 文件，设置环境变量让它能找到
process.env.SQL_JS_WASM_PATH = resolve(pkgDir, 'node_modules/sql.js/dist/sql-wasm.wasm');

const { startMcpServer } = await import(pathToFileURL(resolve(pkgDir, 'dist/mcp-server.js')).href);

const config = {};

if (process.env.ONLYMEM_PROJECT) {
  config.projectId = process.env.ONLYMEM_PROJECT;
}
if (process.env.ONLYMEM_DATA_DIR) {
  config.dataDir = process.env.ONLYMEM_DATA_DIR;
}

startMcpServer(config).catch((err) => {
  console.error('[OnlyMemory] Fatal error:', err);
  process.exit(1);
});
