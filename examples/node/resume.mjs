// Historical supervisor scenarios are available in Git history.
// Refuse before connecting or creating a remote task this mode cannot control.
throw Object.assign(new Error("This live control scenario is disabled in SSH/tmux read-only mode. See docs/direct-ssh.md."), {
  code: "remote-input-disabled", notSubmitted: true,
});
