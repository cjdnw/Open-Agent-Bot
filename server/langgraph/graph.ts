import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { WorkflowDeps } from "./types.ts";
import { WorkflowStateAnnotation, type WorkflowGraphState } from "./state.ts";
import { createWorkflowNodes } from "./nodes.ts";
import { MAX_AUTO_REWORK } from "./types.ts";

export function buildLangGraphWorkflow(deps: WorkflowDeps, checkpointer?: BaseCheckpointSaver) {
  const nodes = createWorkflowNodes(deps);

  const graph = new StateGraph(WorkflowStateAnnotation)
    .addNode("fastGateStep", nodes.fastGateNode)
    .addNode("momoFastChatStep", nodes.momoFastChatNode)
    .addNode("momoLightStep", nodes.momoLightNode)
    .addNode("judgePreReviewStep", nodes.judgePreReviewNode)
    .addNode("workerRegistryLookupStep", nodes.workerRegistryLookupNode)
    .addNode("humanApprovalStep", nodes.humanApprovalNode)
    .addNode("momoPlannerStep", nodes.momoPlannerNode)
    .addNode("routingGuardStep", nodes.routingGuardNode)
    .addNode("momoExecutorStep", nodes.momoExecutorNode)
    .addNode("workerDispatcherStep", nodes.workerDispatcherNode)
    .addNode("judgeFinalReviewStep", nodes.judgeFinalReviewNode)
    .addNode("reworkStep", nodes.reworkNode)
    .addNode("momoDeliveryStep", nodes.momoDeliveryNode)

    .addEdge(START, "fastGateStep")

    .addConditionalEdges("fastGateStep", (state: WorkflowGraphState) => {
      if (state.routeLevel === "L0") return "momoFastChatStep";
      if (state.routeLevel === "L1") return "momoLightStep";
      return "judgePreReviewStep";
    })

    .addEdge("momoFastChatStep", END)

    .addConditionalEdges("momoLightStep", (state: WorkflowGraphState) => {
      if (state.upgradeRequired) return "judgePreReviewStep";
      return END;
    })

    // Judge → WorkerRegistry (never skip registry on formal path)
    .addConditionalEdges("judgePreReviewStep", (state: WorkflowGraphState) => {
      if (state.executionStatus === "BLOCKED" || state.errors.length > 0) return END;
      return "workerRegistryLookupStep";
    })

    .addConditionalEdges("workerRegistryLookupStep", (state: WorkflowGraphState) => {
      if (state.requiresHumanApproval && state.approvalGranted !== true) {
        return "humanApprovalStep";
      }
      return "momoPlannerStep";
    })

    .addConditionalEdges("humanApprovalStep", (state: WorkflowGraphState) => {
      if (state.approvalGranted === true && state.executionStatus !== "CANCELLED") {
        return "momoPlannerStep";
      }
      return END;
    })

    // Momo decision always validated by RoutingGuard
    .addEdge("momoPlannerStep", "routingGuardStep")

    .addConditionalEdges("routingGuardStep", (state: WorkflowGraphState) => {
      const guard = state.routingGuardResult;
      if (!guard) return END;
      if (guard.retryRequested) return "momoPlannerStep";
      if (guard.status === "BLOCKED" || guard.status === "INVALID") return END;
      if (guard.status === "ESCALATE" || state.executionMode === "ESCALATE") {
        return "humanApprovalStep";
      }
      if (state.executionMode === "DELEGATE") return "workerDispatcherStep";
      return "momoExecutorStep";
    })

    .addEdge("momoExecutorStep", "judgeFinalReviewStep")
    .addEdge("workerDispatcherStep", "judgeFinalReviewStep")

    .addConditionalEdges("judgeFinalReviewStep", (state: WorkflowGraphState) => {
      if (state.judgeFinalVerdict === "PASS") return "momoDeliveryStep";
      if (state.judgeFinalVerdict === "FAIL") {
        if (state.reworkCount < MAX_AUTO_REWORK) {
          return "reworkStep";
        }
        return END;
      }
      return END;
    })

    .addEdge("reworkStep", "momoPlannerStep")
    .addEdge("momoDeliveryStep", END);

  return checkpointer ? graph.compile({ checkpointer }) : graph.compile();
}
