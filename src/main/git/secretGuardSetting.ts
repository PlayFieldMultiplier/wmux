// Settings › General "Block passwords and keys in commits, pushes and PRs".
// On unless the user turned it off: the renderer mirrors the saved choice here
// when the session loads and on every change (IPC.SECRET_GUARD_ENABLED), so
// until then — and with no renderer at all — the check runs. Read by the Git
// page's commit / push / PR, task adopt and Moa's delivery, all in main.

let enabled = true;

export function secretGuardEnabled(): boolean {
  return enabled;
}

export function setSecretGuardEnabled(on: boolean): void {
  enabled = on;
}
