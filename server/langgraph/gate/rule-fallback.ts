/**
 * Deterministic Rule Fallback for AI Gate.
 * No LLM. Does not grant tool permissions.
 */
import type { FastGateResult } from "../types.ts";
import type { AiGateClassification, MessageContext } from "./types.ts";

const L0_EXACT = new Set([
  "hello",
  "hi",
  "hey",
  "你好",
  "您好",
  "早",
  "早上好",
  "中午好",
  "下午好",
  "晚上好",
  "在吗",
  "在不在",
  "哈喽",
  "嗨",
  "hi there",
  "hello there",
  "good morning",
  "good afternoon",
  "good evening",
  "谢谢",
  "多谢",
  "非常感谢",
  "感谢",
  "thank you",
  "thanks",
  "thx",
  "thank you so much",
  "不客气",
  "没事",
  "再见",
  "拜拜",
  "bye",
  "goodbye",
  "see you",
  "你是谁",
  "你叫什么",
  "你叫什么名字",
  "who are you",
  "what is your name",
]);

const L3_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(\bdrop\s+database\b|\bdrop\s+table\b|\btruncate\s+table\b|删除数据库|清空数据库|删库)/i, reason: "destructive database op" },
  { re: /(\brm\s+-rf\b|\brmdir\s+\/s\b|\bdel\s+\/f\b|强制删除|清空磁盘)/i, reason: "destructive filesystem op" },
  { re: /(\bssh\b|\bscp\b|\brsync\b|远程登录|远程执行|生产环境|生产服务|生产服务器|\bprod\b|线上生产)/i, reason: "remote/prod action" },
  { re: /(\bdeploy\b|部署到|上线|发布到生产|修改生产服务|rk3576|rknn)/i, reason: "deployment / board flash" },
  { re: /(覆盖.*(权重|checkpoint|模型)|删除.*(权重|checkpoint|训练产物))/i, reason: "irreversible training artifact risk" },
  { re: /(\bchmod\s+777\b|\bchown\b|\bkill\s+-9\b|修改注册表|修改系统环境|关键系统)/i, reason: "privilege / system change" },
];

const L2_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(修改|优化|重构|编写|开发|实现|修复|debug|排查|排错|补丁|删除.*逻辑)/i, reason: "code/engineering change" },
  { re: /(代码|函数|类|接口|模块|文件|\.cpp|\.h|\.ts|\.js|\.py|\.sh|diff|commit|git|pr)/i, reason: "code artifact" },
  { re: /(算法实验|复杂.*分析|技术文档|实验报告|正式交付)/i, reason: "formal deliverable" },
];

const L1_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /^(解释|解释一下|说明|什么是|介绍|介绍一下|如何理解|为什么)/i, reason: "concept explanation" },
  { re: /^(what is|explain|tell me about|how does|why is|describe)\b/i, reason: "concept explanation" },
  { re: /(查看|查询|列出|获取|显示).*(bot|机器人|列表|额度|配额|quota|定时任务|schedule|状态|版本)/i, reason: "readonly status query" },
  { re: /(额度|配额|quota|bot\s*列表|定时任务|schedule).*(状态|查询|查看|快照|历史)/i, reason: "readonly quota/status" },
  { re: /^(list\s+bots|get\s+quota|quota\s+status|schedule\s+status|show\s+bots)\b/i, reason: "readonly quota/status" },
];

const ACTION_TOKENS =
  /(删除|delete|drop|remove|修改|edit|update|部署|deploy|ssh|写|write|创建|create|执行|run|exec|git|push|rm\b)/i;

function normalizeExact(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[!?,.，。！？\s]+|[!?,.，。！？\s]+$/g, "");
}

function combined(text: string, history?: MessageContext[]): string {
  const recent = (history || [])
    .filter((m) => m.role === "user")
    .slice(-2)
    .map((m) => m.text.toLowerCase());
  return [...recent, text.toLowerCase()].join(" \n ");
}

export function ruleFallbackClassify(
  rawRequest: string,
  history?: MessageContext[],
): AiGateClassification {
  const text = (rawRequest || "").trim();
  const lower = text.toLowerCase();
  const ctx = combined(lower, history);

  // Priority 1: high risk
  for (const p of L3_PATTERNS) {
    if (p.re.test(lower) || p.re.test(ctx)) {
      return {
        routeLevel: "L3",
        taskType: /deploy|rk3576|rknn|部署/i.test(lower) ? "DEPLOYMENT" : "DESTRUCTIVE",
        complexityEstimate: "COMPLEX",
        riskEstimate: "HIGH",
        requiresWrite: true,
        requiresExternalAction: true,
        requiresFormalReview: true,
        requiresHumanApproval: true,
        confidence: 1,
        reason: `Rule Fallback L3：${p.reason}`,
      };
    }
  }

  // Priority 2: code / file modification
  for (const p of L2_PATTERNS) {
    if (p.re.test(lower) || p.re.test(ctx)) {
      return {
        routeLevel: "L2",
        taskType: /文档|报告|分析/.test(lower) ? "ANALYSIS" : "CODE_MODIFICATION",
        complexityEstimate: "MODERATE",
        riskEstimate: "MEDIUM",
        requiresWrite: true,
        requiresExternalAction: true,
        requiresFormalReview: true,
        requiresHumanApproval: false,
        confidence: 1,
        reason: `Rule Fallback L2：${p.reason}`,
      };
    }
  }

  // Priority 3: exact L0 whitelist only (whole message)
  const exact = normalizeExact(text);
  if (L0_EXACT.has(exact) && !ACTION_TOKENS.test(text)) {
    return {
      routeLevel: "L0",
      taskType: "CHAT",
      complexityEstimate: "SIMPLE",
      riskEstimate: "LOW",
      requiresWrite: false,
      requiresExternalAction: false,
      requiresFormalReview: false,
      requiresHumanApproval: false,
      confidence: 1,
      reason: "Rule Fallback L0：完整消息命中闲聊白名单",
    };
  }

  // Priority 4: verified readonly L1
  const hasModifying = /(修改|删除|写入|创建|执行|运行|修复|部署|write|edit|delete|update|create|exec|run)/i.test(
    lower,
  );
  if (!hasModifying) {
    for (const p of L1_PATTERNS) {
      if (p.re.test(lower)) {
        return {
          routeLevel: "L1",
          taskType: "QA_READONLY",
          complexityEstimate: "SIMPLE",
          riskEstimate: "LOW",
          requiresWrite: false,
          requiresExternalAction: false,
          requiresFormalReview: false,
          requiresHumanApproval: false,
          confidence: 1,
          reason: `Rule Fallback L1：${p.reason}`,
        };
      }
    }
  }

  // Multi-turn short confirmations inherit risk from history
  if (history?.length && /^(确认|继续|执行|删了它|好的|yes|ok|do it)$/i.test(exact)) {
    for (const p of L3_PATTERNS) {
      if (p.re.test(ctx)) {
        return {
          routeLevel: "L3",
          taskType: "DESTRUCTIVE",
          complexityEstimate: "COMPLEX",
          riskEstimate: "HIGH",
          requiresWrite: true,
          requiresExternalAction: true,
          requiresFormalReview: true,
          requiresHumanApproval: true,
          confidence: 1,
          reason: `Rule Fallback L3：短确认继承上下文高风险（${p.reason}）`,
        };
      }
    }
    for (const p of L2_PATTERNS) {
      if (p.re.test(ctx)) {
        return {
          routeLevel: "L2",
          taskType: "CODE_MODIFICATION",
          complexityEstimate: "MODERATE",
          riskEstimate: "MEDIUM",
          requiresWrite: true,
          requiresExternalAction: true,
          requiresFormalReview: true,
          requiresHumanApproval: false,
          confidence: 1,
          reason: `Rule Fallback L2：短确认继承上下文正式任务（${p.reason}）`,
        };
      }
    }
  }

  // Priority 5: default L2
  return {
    routeLevel: "L2",
    taskType: "UNKNOWN",
    complexityEstimate: "MODERATE",
    riskEstimate: "MEDIUM",
    requiresWrite: false,
    requiresExternalAction: false,
    requiresFormalReview: true,
    requiresHumanApproval: false,
    confidence: 1,
    reason: "Rule Fallback L2：无法可靠归类，保守进入正式评审",
  };
}

/** Backward-compatible Fast Gate API used by older tests. */
export function evaluateFastGate(rawRequest: string, history?: MessageContext[]): FastGateResult {
  const c = ruleFallbackClassify(rawRequest, history);
  return {
    routeLevel: c.routeLevel,
    routeReason: c.reason,
    judgeRequired: c.routeLevel === "L2" || c.routeLevel === "L3",
    suggestedComplexity: c.complexityEstimate,
    suggestedRiskLevel: c.riskEstimate,
  };
}
