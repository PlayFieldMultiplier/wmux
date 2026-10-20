# Connector access scopes

Account authorization, tool permissions, terminal access and bot access are
independent. Connecting an account does not grant tools to an agent.

## Policy and migration

Keep existing bot scope and exclusions unchanged. Add terminal access modes:
off, all ordinary panes, selected workspaces, or selected panes. All includes
future ordinary panes. Workspace and pane exclusions override grants. If an
exclusion cannot be resolved, refuse terminal access until the owner updates
the selection; never silently prune an exclusion and broaden access.

New and legacy connections without a terminal policy have terminal access off.
The old terminal launch was an ephemeral owner action, not a persisted grant.
Malformed terminal policy on disk disables terminal access without discarding
the existing bot grants. Malformed policy submitted for saving is rejected.
The UI distinguishes a legacy unset policy so the owner can review it.

The library format remains version 1. An older application does not enforce
the new terminal policy and can offer its previous explicit copy-launch action.
Downgrading is therefore not a way to retain these controls. It does not grant
automatic access, and preserving existing bot configuration avoids a destructive
format migration.

## Execution and revocation

Replace copying a launch command with an owner-selected, host-controlled launch.
Main validates a live daemon session, its shell process, its current pane and
workspace, and that it is an ordinary idle shell. Deny bot workers, WSL, remote
panes, unknown identity and unsupported platforms. Do not type into an existing
agent or automatically restart it. The owner selects the destination; that
selection is not proof of ownership. Resolve ownership through the trusted
application state rather than accepting a claimed workspace from the caller.

Require the daemon's positive empty-shell-prompt state and a fresh process check.
The daemon atomically compares the logical incarnation, key-input revision,
output size and prompt markers before writing. Unknown or changed state refuses
the launch. This also prevents two concurrent launches from sharing one prompt.

Bind the gateway lease to the selected session, shell process, workspace and
logical session incarnation. Recheck policy and live identity before upstream requests,
after credential refresh, and before returning results. Close leases on policy
changes, session destruction, pane movement and daemon replacement. Once a
request has reached a service, revocation cannot undo its side effects.
An unused lease expires after two minutes. Its first permitted request
extends it up to the gateway's one-hour lifetime. Returning to the shell prompt
closes it. Pane exceptions are pane-specific, not surface-specific.

This is application-managed access and revocation, not an operating-system
sandbox between processes running as the same user. Do not advertise strict
pane isolation. Do not reuse caller-asserted process IDs as authentication.

## Interface and verification

Show terminal scope, Bots scope and tool permissions separately in the existing
connection editor. Show access settings on Windows too, with an explicit
unsupported execution state where applicable. UI plugins have their own display
and trust settings and are outside this connector policy.

OAuth, server checks and terminal gateway SDK code load only on first use.
Registering IPC and observing library changes do not initialize the OAuth SDK.
The lightweight OAuth service still reconciles encrypted records synchronously
on library changes; SDK loading must not delay credential removal or revocation.

Verify legacy bot-grant preservation, malformed policy, exclusions whose targets
disappear or change identity, session replacement, movement, credential-refresh
races, denied requests making no upstream call, idle-shell checks, bot separation,
and persistence. Run the repository verification gate, actual Opus code review,
security review, packaged UI checks and Windows verification before merging.
