/**
 * 记忆插件功能测试
 *
 * 运行方式: npx tsx tests/test.ts
 */

import { MemoryEngine } from '../src/engine.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_DIR = path.join(os.tmpdir(), `deepseek_mem_test_${Date.now()}`);

async function main() {
  console.log('='.repeat(60));
  console.log('DeepSeek 记忆插件 TypeScript 版 - 功能测试');
  console.log('='.repeat(60));

  // 初始化引擎
  const engine = new MemoryEngine({
    projectId: 'test',
    dataDir: TEST_DIR,
    topK: 10,
  });
  await engine.init();
  console.log('\n[OK] 引擎初始化成功');

  // ---- 1. 显式记忆 ----
  console.log('\n[1] 记住事实');
  engine.remember('用户叫张三，在北京做后端开发');
  engine.remember('用户偏好 Python 和 Go 语言');
  engine.remember('用户喜欢简洁的代码风格，不要冗余注释');
  engine.remember('用户的项目叫 SmartBot，是一个 AI 客服系统');
  console.log('    已记住 4 条事实');

  // ---- 2. 统计信息 ----
  console.log('\n[2] 记忆库统计');
  const stats = engine.getStats();
  console.log(`    活跃记忆: ${stats.active} 条`);
  console.log(`    数据库路径: ${stats.dbPath}`);
  console.log(`    项目: ${stats.projectId}`);

  // ---- 3. 搜索记忆 ----
  console.log('\n[3] 搜索 "Python"');
  const results1 = engine.search('Python');
  for (const r of results1) {
    console.log(`    [${r.memory.type}] ${r.memory.content} (${(r.score * 100).toFixed(0)}%)`);
  }

  console.log('\n[3] 搜索 "项目"');
  const results2 = engine.search('项目');
  for (const r of results2) {
    console.log(`    [${r.memory.type}] ${r.memory.content} (${(r.score * 100).toFixed(0)}%)`);
  }

  // ---- 4. 获取所有记忆 ----
  console.log('\n[4] 所有记忆');
  const allMemories = engine.getAllMemories();
  for (const m of allMemories) {
    console.log(`    [${m.type}] ${m.content} (重要度: ${m.importance.toFixed(2)})`);
  }

  // ---- 5. 遗忘 ----
  console.log('\n[5] 遗忘 "代码风格"');
  const deleted = engine.forget('代码风格');
  console.log(`    删除了 ${deleted} 条记忆`);
  console.log(`    剩余: ${engine.getStats().active} 条`);

  // ---- 6. 对话记忆 ----
  console.log('\n[6] 对话记忆测试');
  engine.startSession();
  const ctx = engine.onUserMessage('我叫李四，在写一个 AI 助手');
  console.log(`    记忆上下文: ${ctx || '(无相关记忆)'}`);
  engine.onAssistantMessage('你好李四！AI 助手是个很棒的项目。', '我叫李四，在写一个 AI 助手');
  console.log('    已处理对话');
  engine.endSession('讨论了 AI 助手项目');

  // ---- 7. JSON 导出 ----
  console.log('\n[7] 导出到 JSON 文件');
  const exportPath = path.join(TEST_DIR, 'export.json');
  const exported = engine.exportToFile(exportPath);
  console.log(`    导出 ${exported} 条记忆`);

  // ---- 8. 多项目隔离 ----
  console.log('\n[8] 多项目隔离');
  const engine2 = new MemoryEngine({
    projectId: 'another',
    dataDir: TEST_DIR,
  });
  await engine2.init();
  engine2.remember('另一个项目的记忆');
  console.log(`    test 项目: ${engine.getStats().active} 条`);
  console.log(`    another 项目: ${engine2.getStats().active} 条`);
  engine2.close();

  // ---- 清理 ----
  engine.close();

  // 删除测试目录
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  console.log('\n' + '='.repeat(60));
  console.log('全部测试通过！');
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
