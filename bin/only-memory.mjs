#!/usr/bin/env node
/**
 * OnlyMemory Server - 启动入口
 *
 * 同时启动两个服务：
 *   1. MCP stdio 服务器 — 供 Harness 通过 dsh-mcp-client 调用
 *   2. Web 管理界面 — 在浏览器中查看和管理记忆
 *
 * 环境变量配置（可选）：
 *   ONLYMEM_PROJECT    - 项目标识（默认 "default"）
 *   ONLYMEM_DATA_DIR   - 数据目录（默认 ~/.onlymem）
 *   ONLYMEM_WEB_PORT   - Web 管理界面端口（默认 3456，0 = 禁用）
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..');

// sql.js 需要定位 WASM 文件
process.env.SQL_JS_WASM_PATH = resolve(pkgDir, 'node_modules/sql.js/dist/sql-wasm.wasm');

// 动态导入编译后的模块
const { startMcpServer } = await import(pathToFileURL(resolve(pkgDir, 'dist/mcp-server.js')).href);
const { WebServer } = await import(pathToFileURL(resolve(pkgDir, 'dist/web-server.js')).href);
const { MemoryEngine } = await import(pathToFileURL(resolve(pkgDir, 'dist/engine.js')).href);

// 构建配置
const config = {};
if (process.env.ONLYMEM_PROJECT) config.projectId = process.env.ONLYMEM_PROJECT;
if (process.env.ONLYMEM_DATA_DIR) config.dataDir = process.env.ONLYMEM_DATA_DIR;

// 创建并初始化共享引擎
const engine = new MemoryEngine(config);
await engine.init();

// Web 端口（默认 3456，设为 0 可禁用）
const webPort = parseInt(process.env.ONLYMEM_WEB_PORT || '3456', 10);

// 启动 Web 管理界面
let webServer = null;
if (webPort > 0) {
  webServer = new WebServer({ engine, port: webPort });
  try {
    await webServer.start();
    process.stderr.write(`[OnlyMemory] Web UI: http://127.0.0.1:${webPort}\n`);
  } catch (err) {
    process.stderr.write(`[OnlyMemory] Web server failed: ${err.message}\n`);
    process.stderr.write(`[OnlyMemory] Set ONLYMEM_WEB_PORT=0 to disable web UI\n`);
    webServer = null;
  }
}

// 启动 MCP stdio 服务器（共享同一个引擎）
await startMcpServer(config, engine);

// 优雅关闭
const shutdown = async () => {
  if (webServer) await webServer.stop();
  engine.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
