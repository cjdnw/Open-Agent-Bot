import type { FastGateResult } from "./types.ts";

// Pure greetings and short chit-chat expressions
const L0_EXACT_PATTERNS = new Set([
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

// Keywords that indicate actions, modifications, danger, or tool use — immediate disqualification from L0
const ACTION_AND_DANGER_KEYWORDS = [
  "删除",
  "delete",
  "drop",
  "remove",
  "rm",
  "clean",
  "clear",
  "kill",
  "format",
  "truncate",
  "修改",
  "edit",
  "update",
  "modify",
  "change",
  "fix",
  "refactor",
  "patch",
  "实现",
  "implement",
  "write",
  "写",
  "创建",
  "create",
  "build",
  "compile",
  "编译",
  "部署",
  "deploy",
  "ssh",
  "server",
  "服务器",
  "git",
  "commit",
  "push",
  "pull",
  "clone",
  "diff",
  "test",
  "测试",
  "run",
  "exec",
  "bash",
  "shell",
  "powershell",
  "cmd",
  "curl",
  "wget",
  "python",
  "cpp",
  "c++",
  "node",
  "ts",
  "database",
  "db",
  "数据库",
  "table",
  "prod",
  "production",
  "生产",
  "config",
  "配置",
  "secret",
  "key",
  "token",
  "api",
  "mcp",
  "worker",
  "judge",
  "architect",
  "developer",
  "deployer",
  "qa",
  "reporter",
];

// Patterns that indicate high-risk actions (L3)
const L3_HIGH_RISK_PATTERNS = [
  /(\bdrop\s+database\b|\bdrop\s+table\b|\btruncate\s+table\b|删除数据库|清空数据库|删库)/i,
  /(\brm\s+-rf\b|\brmdir\s+\/s\b|\bdel\s+\/f\b|强制删除|清空磁盘)/i,
  /(\bssh\b|\bscp\b|\brsync\b|远程登录|远程执行|生产环境|生产服务|\bprod\b|线上生产)/i,
  /(\bdeploy\b|部署到|上线|发布到生产|修改生产服务)/i,
  /(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})/, // IP addresses / remote servers
  /(\bchmod\s+777\b|\bchown\b|\bkill\s+-9\b|\bkillall\b|修改注册表|修改系统环境)/i,
];

// Patterns that indicate lightweight read-only queries (L1)
const L1_READONLY_PATTERNS = [
  /^(解释|解释一下|说明|什么是|介绍|介绍一下|如何理解|为什么)/i,
  /^(what is|explain|tell me about|how does|why is|describe)\b/i,
  /(查看|查询|列出|获取|显示).*(bot|机器人|列表|额度|配额|quota|定时任务|schedule|状态|版本)/i,
  /(额度|配额|quota|bot\s*列表|定时任务|schedule).*(状态|查询|查看|快照|历史)/i,
  /^(list\s+bots|get\s+quota|quota\s+status|schedule\s+status|show\s+bots)\b/i,
];

// Patterns that indicate code modification or technical delivery (L2)
const L2_REVIEWED_PATTERNS = [
  /(修改|优化|重构|编写|开发|实现|修复|debug|排查|排错|补丁)/i,
  /(代码|函数|类|接口|模块|文件|算法|模型|测试|回归|用例)/i,
  /(\.cpp|\.h|\.ts|\.js|\.py|\.sh|\.json|\.md|diff|commit|git|pr)/i,
  /(rknn|cenet|bev|conv|qat|ptq|onnx|tensorboard)/i,
];

export interface MessageContext {
  role: "user" | "assistant" | "system";
  text: string;
}

/**
 * Fast Gate deterministic routing evaluator.
 *
 * Evaluates whether a user request requires the full Judge + LangGraph Workflow
 * without incurring extra model calls or latency.
 *
 * L0: Fast Chat (hello, 你好, 谢谢) -> Momo direct reply
 * L1: Lightweight Task (read-only query, quota inspection, explanation) -> Momo solo
 * L2: Reviewed Task (code modification, tests, docs, quality verification) -> Judge Pre-Review + Momo + Judge Final Review
 * L3: High-Risk Task (deployment, production modification, data deletion, SSH) -> Judge Pre-Review + Human Approval + Momo + Judge Final Review
 */
export function evaluateFastGate(
  rawRequest: string,
  history?: MessageContext[],
): FastGateResult {
  const text = (rawRequest || "").trim();
  const lower = text.toLowerCase();

  // Multi-turn context check: if the latest prompt is short (e.g. "yes", "继续", "确认", "删了它"),
  // look at recent history to prevent disguising dangerous commands as simple replies.
  const hasHistory = Array.isArray(history) && history.length > 0;
  const recentUserRequests = hasHistory
    ? history
        .filter((m) => m.role === "user")
        .slice(-2)
        .map((m) => m.text.toLowerCase())
    : [];

  const combinedContext = [...recentUserRequests, lower].join(" ");

  // 1. Check L3 High-Risk first
  for (const pattern of L3_HIGH_RISK_PATTERNS) {
    if (pattern.test(lower) || (hasHistory && pattern.test(combinedContext))) {
      return {
        routeLevel: "L3",
        routeReason: `检测到高风险或生产系统操作：${pattern.source}`,
        judgeRequired: true,
        suggestedComplexity: "COMPLEX",
        suggestedRiskLevel: "HIGH",
      };
    }
  }

  // 2. Check for action & danger keywords. If any are present, CANNOT BE L0!
  const hasActionKeyword = ACTION_AND_DANGER_KEYWORDS.some((kw) => lower.includes(kw));

  // 3. Check L0 Fast Chat
  // Must match exact chit-chat or clean greeting without any action keywords
  const stripped = lower.replace(/^[!?,.，。！？\s]+|[!?,.，。！？\s]+$/g, "");
  const isExactL0 = L0_EXACT_PATTERNS.has(stripped);
  const isShortGreeting =
    !hasActionKeyword &&
    stripped.length <= 15 &&
    (stripped.startsWith("你好") ||
      stripped.startsWith("hello") ||
      stripped.startsWith("hi ") ||
      stripped === "hi" ||
      stripped.startsWith("早") ||
      stripped.includes("谢谢") ||
      stripped.includes("thanks"));

  if (!hasActionKeyword && (isExactL0 || isShortGreeting)) {
    return {
      routeLevel: "L0",
      routeReason: "简单对话与日常问候，不涉及任务执行",
      judgeRequired: false,
      suggestedComplexity: "SIMPLE",
      suggestedRiskLevel: "LOW",
    };
  }

  // 4. Check L1 Lightweight Task (pure read-only query / explanation / quota)
  // Must not have modifying verbs or write actions
  const hasModifyingAction = /(修改|删除|写入|创建|执行|运行|修复|部署|write|edit|delete|update|create|exec|run)/i.test(
    lower,
  );
  if (!hasModifyingAction) {
    for (const pattern of L1_READONLY_PATTERNS) {
      if (pattern.test(lower)) {
        return {
          routeLevel: "L1",
          routeReason: "低风险只读查询或概念说明，不涉及代码或生产变更",
          judgeRequired: false,
          suggestedComplexity: "SIMPLE",
          suggestedRiskLevel: "LOW",
        };
      }
    }
  }

  // 5. Check L2 Reviewed Task (code, tests, experiments, docs)
  for (const pattern of L2_REVIEWED_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        routeLevel: "L2",
        routeReason: "代码开发、算法修改或需要独立验收的正式交付物",
        judgeRequired: true,
        suggestedComplexity: "MODERATE",
        suggestedRiskLevel: "MEDIUM",
      };
    }
  }

  // 6. Conservative Fallback: When uncertain, enter L2 formal workflow
  return {
    routeLevel: "L2",
    routeReason: "未明确归类任务，保守进入正式评审工作流",
    judgeRequired: true,
    suggestedComplexity: "MODERATE",
    suggestedRiskLevel: "MEDIUM",
  };
}
