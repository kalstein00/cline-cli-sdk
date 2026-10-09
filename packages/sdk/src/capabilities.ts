export interface FeatureCapability {
  availability: "supported" | "unsupported" | "unknown";
  evidence: "verified-profile" | "help" | "declared" | "unobserved";
  reason: string;
}
export type CliFeatures = Record<"zen" | "jsonOutput" | "jsonInteraction" | "jsonResume" | "reasoning" | "nativeSchema", FeatureCapability>;
export interface DeclaredFeatures { zen?: boolean; jsonOutput?: boolean }

export function cliFeatures(verified: boolean, flags?: string[], declared?: DeclaredFeatures): CliFeatures {
  const unknown = (): FeatureCapability => ({availability:"unknown",evidence:"unobserved",reason:"No verified CLI observation."});
  const profile = (supported: boolean, reason: string): FeatureCapability => ({availability:supported?"supported":"unsupported",evidence:"verified-profile",reason});
  const flag = (name: keyof DeclaredFeatures, option: string): FeatureCapability => {
    if (verified) return profile(true, `Pinned CLI exposes ${option}; protocol support is reported separately.`);
    if (flags?.includes(option)) return {availability:"supported",evidence:"help",reason:"Observed help only; execution profile remains unverified."};
    if (declared?.[name] !== undefined) return {availability:declared[name]?"supported":"unsupported",evidence:"declared",reason:"User declaration; execution profile remains unverified."};
    return unknown();
  };
  return {
    zen:flag("zen","--zen"), jsonOutput:flag("jsonOutput","--json"),
    jsonInteraction:verified?profile(false,"JSON mode has no verified response path."):unknown(),
    jsonResume:verified?profile(false,"Pinned JSON mode cannot use the verified TUI resume path."):unknown(),
    reasoning:verified?profile(true,"History can expose thinking blocks; models may omit them."):unknown(),
    nativeSchema:verified?profile(false,"Pinned CLI exposes no native JSON Schema generation option."):unknown(),
  };
}
