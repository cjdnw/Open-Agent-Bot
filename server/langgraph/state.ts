import { Annotation } from "@langchain/langgraph";
import type {
  Complexity,
  ExecutionRecord,
  FinalReview,
  JudgeVerdict,
  MomoPlan,
  PreReview,
  RiskLevel,
  RouteLevel,
} from "./types.ts";
import type { RegistryLookupResult, WorkerCapability } from "./worker-registry.ts";
import type { RoutingGuardResult, TaskAssignment } from "./routing-guard.ts";
import type { GateAuditRecord } from "./gate/types.ts";

export const WorkflowStateAnnotation = Annotation.Root({
  workflowId: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  threadId: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  momoBotId: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  judgeBotId: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  userRequest: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  routeLevel: Annotation<RouteLevel>({
    reducer: (curr, update) => update ?? curr ?? "L2",
    default: () => "L2",
  }),
  routeReason: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  judgeRequired: Annotation<boolean>({
    reducer: (curr, update) => update ?? curr ?? true,
    default: () => true,
  }),
  complexity: Annotation<Complexity>({
    reducer: (curr, update) => update ?? curr ?? "MODERATE",
    default: () => "MODERATE",
  }),
  riskLevel: Annotation<RiskLevel>({
    reducer: (curr, update) => update ?? curr ?? "MEDIUM",
    default: () => "MEDIUM",
  }),
  reasoningEffective: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "HIGH",
    default: () => "HIGH",
  }),
  acceptanceCriteria: Annotation<string[]>({
    reducer: (curr, update) => update ?? curr ?? [],
    default: () => [],
  }),
  requiredEvidence: Annotation<string[]>({
    reducer: (curr, update) => update ?? curr ?? [],
    default: () => [],
  }),
  requiresHumanApproval: Annotation<boolean>({
    reducer: (curr, update) => update ?? curr ?? false,
    default: () => false,
  }),
  judgePreReview: Annotation<PreReview | null>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => null,
  }),
  momoDecision: Annotation<MomoPlan | null>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => null,
  }),
  executionMode: Annotation<"SELF" | "DELEGATE" | "ESCALATE">({
    reducer: (curr, update) => update ?? curr ?? "SELF",
    default: () => "SELF",
  }),
  selectedBots: Annotation<string[]>({
    reducer: (curr, update) => update ?? curr ?? [],
    default: () => [],
  }),
  currentExecutor: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "momo",
    default: () => "momo",
  }),
  executionStatus: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "PENDING",
    default: () => "PENDING",
  }),
  artifactReferences: Annotation<string[]>({
    reducer: (curr, update) => Array.from(new Set([...(curr ?? []), ...(update ?? [])])),
    default: () => [],
  }),
  evidenceReferences: Annotation<string[]>({
    reducer: (curr, update) => Array.from(new Set([...(curr ?? []), ...(update ?? [])])),
    default: () => [],
  }),
  executionSummary: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  executionRecord: Annotation<ExecutionRecord | null>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => null,
  }),
  criteriaVersion: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  artifactHash: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  judgeFinalVerdict: Annotation<JudgeVerdict | null>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => null,
  }),
  judgeFinalReview: Annotation<FinalReview | null>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => null,
  }),
  reworkCount: Annotation<number>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => 0,
  }),
  pendingApproval: Annotation<boolean>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => false,
  }),
  approvalGranted: Annotation<boolean | null>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => null,
  }),
  activeAttemptId: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  errors: Annotation<string[]>({
    reducer: (curr, update) => (update ? [...(curr ?? []), ...(Array.isArray(update) ? update : [update])] : (curr ?? [])),
    default: () => [],
  }),
  timestamps: Annotation<Record<string, number>>({
    reducer: (curr, update) => ({ ...(curr ?? {}), ...(update ?? {}) }),
    default: () => ({}),
  }),
  history: Annotation<Array<{ state: string; at: number; note?: string }>>({
    reducer: (curr, update) => [...(curr ?? []), ...(update ?? [])],
    default: () => [],
  }),
  output: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  upgradeRequired: Annotation<boolean>({
    reducer: (curr, update) => update ?? curr ?? false,
    default: () => false,
  }),
  workerRegistry: Annotation<RegistryLookupResult | null>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => null,
  }),
  workerCapabilities: Annotation<WorkerCapability[]>({
    reducer: (curr, update) => update ?? curr ?? [],
    default: () => [],
  }),
  routingGuardResult: Annotation<RoutingGuardResult | null>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => null,
  }),
  routingRetryCount: Annotation<number>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => 0,
  }),
  routingCorrectionHint: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  taskAssignments: Annotation<TaskAssignment[]>({
    reducer: (curr, update) => update ?? curr ?? [],
    default: () => [],
  }),
  routingSource: Annotation<"MOMO" | "ROUTING_GUARD" | "">({
    reducer: (curr, update) => update ?? curr ?? "",
    default: () => "",
  }),
  gateAudit: Annotation<GateAuditRecord | null>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => null,
  }),
  requiresWrite: Annotation<boolean>({
    reducer: (curr, update) => update ?? curr ?? false,
    default: () => false,
  }),
});

export type WorkflowGraphState = typeof WorkflowStateAnnotation.State;

