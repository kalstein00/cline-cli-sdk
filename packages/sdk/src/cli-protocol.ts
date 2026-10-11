type Protocol = "readline" | "tui" | "json";

export const profileFor = (mode: "terminal" | "json", terminal: "readline" | "tui") =>
  `cline-${mode === "json" ? "json" : terminal}`;

// Historical recordings retain their original profile labels. Version is metadata only.
export function hasCliProtocol(cli: {name: string; profile: string} | undefined, protocol: Protocol): boolean {
  return cli?.name === "cline" &&
    [ `cline-${protocol}`, `cline-3.0.69-${protocol}` ].includes(cli.profile);
}
