/**
 * 实体抽取器 - 基于正则的轻量级实现
 *
 * 支持中文人名、英文词、技术名词、邮箱等。
 */

const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // 中文人名（2-4个汉字）
  { name: 'cn_name', regex: /(?<![a-zA-Z\u4e00-\u9fff])[\u4e00-\u9fff]{2,4}(?![a-zA-Z\u4e00-\u9fff])/g },
  // 英文专有名词（大写开头的单词）
  { name: 'en_proper', regex: /\b[A-Z][a-zA-Z]{2,}\b/g },
  // 技术名词（常见编程语言/框架/工具）
  { name: 'tech', regex: /\b(Python|JavaScript|TypeScript|Java|Go|Rust|React|Vue|Docker|Kubernetes|Redis|MongoDB|PostgreSQL|SQLite|MySQL|Linux|AWS|Azure|GCP|Node\.?js|FastAPI|Django|Flask|Spring|TensorFlow|PyTorch|DeepSeek|OpenAI|Claude|GPT)\b/gi },
  // 邮箱
  { name: 'email', regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
];

export class EntityExtractor {
  /** 从文本中抽取实体 */
  extract(text: string): string[] {
    const entities = new Set<string>();

    for (const { regex } of PATTERNS) {
      regex.lastIndex = 0; // Reset stateful regex
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const entity = match[0].trim();
        if (entity.length >= 2 && entity.length <= 50) {
          entities.add(entity);
        }
      }
    }

    return [...entities];
  }
}
