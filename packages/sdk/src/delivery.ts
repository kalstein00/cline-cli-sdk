import { createHash } from "node:crypto";
import type { Snapshot, ResponseResult } from "./reducer.js";

export interface DurableResponse {
  requestId: string;
  state: "reserved" | "queued" | "written" | "rejected";
  resolution?: "delivered" | "not-submitted";
  binding: {
    sessionId: string;
    executionId: string;
    interactionId: string;
    revision: number;
    toolId: string;
    kind: string;
    answerDigest: string;
  };
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function deliveryState(
  receipt: DurableResponse,
  snapshot: Snapshot,
  result: { digest: string; rejected: boolean } | undefined,
  process: any,
): ResponseResult["state"] {
  if (!receipt.binding) return "delivery-unknown";
  if (receipt.resolution) return receipt.resolution;
  if (receipt.state === "reserved" || receipt.state === "rejected")
    return "not-submitted";
  const binding = receipt.binding;
  if (binding.kind === "approval") {
    if (binding.answerDigest === digest("Deny") && result?.rejected)
      return "delivered";
    if (
      binding.answerDigest === digest("Approve") &&
      ((result && !result.rejected) ||
        (snapshot.interaction?.kind === "question" &&
          snapshot.interaction.toolId === binding.toolId &&
          snapshot.interaction.id !== binding.interactionId))
    )
      return "delivered";
  } else if (
    binding.kind === "question" &&
    result?.digest === binding.answerDigest
  )
    return "delivered";
  else if (
    binding.kind === "recovery" &&
    receipt.state === "written" &&
    ((process?.identityConfirmed &&
      !process.alive &&
      process.exitCode !== null) ||
      (snapshot.interaction?.kind === "approval" &&
        snapshot.interaction.id !== binding.interactionId))
  )
    return "delivered";
  return "delivery-unknown";
}
