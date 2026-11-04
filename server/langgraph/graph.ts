import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { WorkflowDeps } from "./types.ts";
import { WorkflowStateAnnotation, type WorkflowGraphState } from "./state.ts";
import { createWorkflowNodes } from "./nodes.ts";
import { MAX_AUTO_REWORK } from "./types.ts";

export function buildLangGraphWorkflow(deps: WorkflowDeps, checkpointer?: BaseCheckpointSaver) {
  const nodes = createWorkflowNodes(deps);

  const graph = new StateGraph(WorkflowStateAnnotation)
    // 1. Register Nodes
    .addNode("fastGateStep", nodes.fastGateNode)
    .addNode("momoFastChatStep", nodes.momoFastChatNode)
    .addNode("momoLightStep", nodes.momoLightNode)
    .addNode("judgePreReviewStep", nodes.judgePreReviewNode)
    .addNode("humanApprovalStep", nodes.humanApprovalNode)
    .addNode("momoPlannerStep", nodes.momoPlannerNode)
    .addNode("momoExecutorStep", nodes.momoExecutorNode)
    .addNode("workerDispatcherStep", nodes.workerDispatcherNode)
    .addNode("judgeFinalReviewStep", nodes.judgeFinalReviewNode)
    .addNode("reworkStep", nodes.reworkNode)
    .addNode("momoDeliveryStep", nodes.momoDeliveryNode)

    // 2. Fixed Edge: START → fastGateStep
    .addEdge(START, "fastGateStep")

    // 3. Conditional Edge: fastGateStep
    .addConditionalEdges("fastGateStep", (state: WorkflowGraphState) => {
      if (state.routeLevel === "L0") return "momoFastChatStep";
      if (state.routeLevel === "L1") return "momoLightStep";
      return "judgePreReviewStep";
    })

    // 4. Fixed Edge: momoFastChatStep → END
    .addEdge("momoFastChatStep", END)

    // 5. Conditional Edge: momoLightStep
    .addConditionalEdges("momoLightStep", (state: WorkflowGraphState) => {
      if (state.upgradeRequired) return "judgePreReviewStep";
      return END;
    })

    // 6. Conditional Edge: judgePreReviewStep
    .addConditionalEdges("judgePreReviewStep", (state: WorkflowGraphState) => {
      if (state.executionStatus === "BLOCKED" || state.errors.length > 0) return END;
      if (state.requiresHumanApproval && state.approvalGranted !== true) {
        return "humanApprovalStep";
      }
      return "momoPlannerStep";
    })

    // 7. Conditional Edge: humanApprovalStep (after interrupt resume)
    .addConditionalEdges("humanApprovalStep", (state: WorkflowGraphState) => {
      if (state.approvalGranted === true && state.executionStatus !== "CANCELLED") {
        return "momoPlannerStep";
      }
      return END;
    })

    // 8. Conditional Edge: momoPlannerStep
    .addConditionalEdges("momoPlannerStep", (state: WorkflowGraphState) => {
      if (state.executionStatus === "FAILED" || state.errors.length > 0) return END;
      if (state.executionMode === "ESCALATE") return "humanApprovalStep";
      if (state.executionMode === "DELEGATE") return "workerDispatcherStep";
      return "momoExecutorStep";
    })

    // 9. Fixed Edges to Final Review
    .addEdge("momoExecutorStep", "judgeFinalReviewStep")
    .addEdge("workerDispatcherStep", "judgeFinalReviewStep")

    // 10. Conditional Edge: judgeFinalReviewStep
    .addConditionalEdges("judgeFinalReviewStep", (state: WorkflowGraphState) => {
      if (state.judgeFinalVerdict === "PASS") return "momoDeliveryStep";
      if (state.judgeFinalVerdict === "FAIL") {
        if (state.reworkCount < MAX_AUTO_REWORK) {
          return "reworkStep";
        }
        return END;
      }
      return END; // BLOCKED or error
    })

    // 11. Edge: reworkStep → momoPlannerStep
    .addEdge("reworkStep", "momoPlannerStep")

    // 12. Edge: momoDeliveryStep → END
    .addEdge("momoDeliveryStep", END);

  return checkpointer ? graph.compile({ checkpointer }) : graph.compile();
}
