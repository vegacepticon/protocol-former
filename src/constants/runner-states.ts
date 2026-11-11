export const RUNNER_STATUS = {
  IDLE: "idle" as const,
  AT_NODE: "at-node" as const,
  AWAITING_SNIPPET_PICK: "awaiting-snippet-pick" as const,
  AWAITING_LOOP_PICK: "awaiting-loop-pick" as const,
  AWAITING_SNIPPET_FILL: "awaiting-snippet-fill" as const,
  COMPLETE: "complete" as const,
  ERROR: "error" as const,
} as const;
