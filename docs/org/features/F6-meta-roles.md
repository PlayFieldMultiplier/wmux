# F6: Meta-project roles (Claude Code login and Remote Control keeper)

**Goal:** the org instance has the same meta-project roles the MERIDIAN workspace has today, so that logins stay fresh, Remote Control stays connected, and quota is watched. Those roles run in their own workspace (ORG/META), and they are the only roles allowed to start a login.

**Steps:**

1. Define the RC keeper role (equivalent of `rabbit-0`) in `src/org/meta/roles/rc-keeper.md`.
2. Define the login executor role (equivalent of `rabbit-0.1`) and the global-credentials vessel role (equivalent of `rabbit-0.2`), with their scopes written out.
3. Give the ORG/META workspace a quota and RC heartbeat, reading `agentStatus` across all org surfaces.
4. Route every login through the META workspace, and no other department may start one.

## Current state (verified)

- The MERIDIAN fleet runs these roles today: `hazrat-rabbit` (dispatcher), `hazrat-rabbit-rabbit0` (quota guardian, RC sweep, login authority), `hazrat-rabbit-rabbit01` (login executor, Haiku), `hazrat-rabbit-rabbit02` (global-credentials vessel). Names are from the agent list in this session.
- The RC disconnect message and the recovery are `/remote-control`, typed into the affected pane (`C:\Users\victorb\.claude\rc-and-wmux.md`).
- A write to `~/.claude/.credentials.json` disconnects every Claude Code process on the machine (`~/.agents/ao-wmux/AGENTS.md`, which is not loaded by any agent, and the same fact in `RESEARCH-DIGEST.md` section 6).
- A login dance has a known flow in `hazrat-rabbit.md` (the "Login Dance" section), with local script copies under `C:\Users\victorb\_\AS\hazrat-rabbit\cmd\`. Those scripts are not in our repo.
- The RC heartbeat is described as "not yet built" in `rc-and-wmux.md`.

## Gap

- The org instance has no META workspace, and no RC keeper role.
- The login flow depends on global credentials. F1 flagged that a second window does not isolate them.
- The RC heartbeat does not exist for any instance.

## Design

- **Single login authority.** Only ORG/META runs `/login` or any credential write. Other departments report a disconnect to ORG/META through the stream (F5), and do not fix it themselves.
- **Heartbeat.** The RC keeper reads `agentStatus` through `surface_list` on every org workspace at a fixed interval, and records each disconnect as a stream item. It sends `/remote-control` only to a pane it has confirmed is disconnected, and only after a read-back.
- **Quota.** The keeper records quota readings for the org's account in a telemetry file. It does not send readings to other agents. This is the standing rule in `hazrat-rabbit.md` ("Never relay quota readings to other agents").
- **Config dir (open).** A per-instance `CLAUDE_CONFIG_DIR` would limit a credential write to one instance. This is untested for Claude Code and must be proven before relying on it.

## Folder changes (fork)

- `src/org/meta/roles/` (new): `rc-keeper.md`, `login-executor.md`, `credentials-vessel.md`.
- `src/org/meta/heartbeat.ts` (new), with tests.

## Open decisions

- Whether the org gets its own accounts, or shares the MERIDIAN accounts (LEDGER L-11).
- Whether the login scripts are copied into `config/org/` or referenced from their current location.

## Verification

- The heartbeat finds a disconnected test pane and records one stream item, then sends `/remote-control`, then confirms with a read-back.
- A login started from any non-META workspace is refused by the scope rule.

## Status

Designed. Not built. Accounts and scripts are open (L-11).
