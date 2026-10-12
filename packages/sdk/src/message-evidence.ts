/** A rejected parent alone is insufficient if an earlier composer chunk was written. */
export function messageNotSubmitted(receipt: any): boolean {
  return receipt?.state === "rejected" && receipt.resolution === "not-submitted" &&
    Array.isArray(receipt.steps) && receipt.steps.every((step: any) =>
      step.index === 0 && step.state === "rejected") && receipt.steps.length <= 1;
}
