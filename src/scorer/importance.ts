/**
 * 重要性评分器 - 6因子加权评分
 *
 * 因子权重：
 * - 显式指令 0.30
 * - 新颖性   0.20
 * - 情感强度 0.10
 * - 实体密度 0.15
 * - 行为信息 0.15
 * - 时效性   0.10
 */

import { MemoryType } from '../models.js';
import type { EntityExtractor } from '../encoder/entity-extractor.js';

/** 评分结果 */
export interface ScoreResult {
  score: number;
  factors: Record<string, number>;
}

export class ImportanceScorer {
  private extractor: EntityExtractor;

  constructor(extractor: EntityExtractor) {
    this.extractor = extractor;
  }

  /** 计算重要性分数（0~1） */
  score(text: string, type: MemoryType): ScoreResult {
    const factors: Record<string, number> = {};

    // 1. 显式指令信号
    factors.explicit = this.scoreExplicit(text);

    // 2. 新颖性（基于文本长度的代理指标）
    factors.novelty = this.scoreNovelty(text);

    // 3. 情感强度
    factors.emotion = this.scoreEmotion(text);

    // 4. 实体密度
    factors.entity = this.scoreEntityDensity(text);

    // 5. 行为信息
    factors.behavior = this.scoreBehavior(text, type);

    // 6. 时效性
    factors.timeliness = this.scoreTimeliness(text);

    // 加权求和
    const weights: Record<string, number> = {
      explicit: 0.30,
      novelty: 0.20,
      emotion: 0.10,
      entity: 0.15,
      behavior: 0.15,
      timeliness: 0.10,
    };

    let total = 0;
    for (const [key, weight] of Object.entries(weights)) {
      total += (factors[key] ?? 0) * weight;
    }

    return {
      score: Math.min(1.0, Math.max(0.0, total)),
      factors,
    };
  }

  private scoreExplicit(text: string): number {
    const patterns = [
      /请记住|记住|重要|注意|记住这个|务必|一定要|必须|remember|important|note/i,
      /我叫|我的名字|my name|I am|I'm/i,
      /我偏好|我喜欢|我习惯|I prefer|I like/i,
      /我的项目|我的工作|my project|my work/i,
    ];
    for (const p of patterns) {
      if (p.test(text)) return 1.0;
    }
    return 0.2;
  }

  private scoreNovelty(text: string): number {
    const len = text.length;
    if (len > 100) return 0.8;
    if (len > 50) return 0.6;
    if (len > 20) return 0.4;
    return 0.3;
  }

  private scoreEmotion(text: string): number {
    const emotional = /！+|!+|非常|特别|极其|hate|love|amazing|terrible|worst|best|urgent|紧急/i;
    if (emotional.test(text)) return 0.9;
    return 0.3;
  }

  private scoreEntityDensity(text: string): number {
    const entities = this.extractor.extract(text);
    if (entities.length >= 5) return 1.0;
    if (entities.length >= 3) return 0.7;
    if (entities.length >= 1) return 0.4;
    return 0.1;
  }

  private scoreBehavior(text: string, type: MemoryType): number {
    if (type === MemoryType.Behavior) return 1.0;
    if (type === MemoryType.Preference) return 0.8;
    const behaviorWords = /每次|总是|经常|习惯|从不|usually|always|never|often|sometimes/i;
    return behaviorWords.test(text) ? 0.7 : 0.2;
  }

  private scoreTimeliness(text: string): number {
    const timeWords = /今天|昨天|明天|现在|最近|刚刚|today|yesterday|tomorrow|now|recent|just/i;
    return timeWords.test(text) ? 0.8 : 0.5;
  }
}
