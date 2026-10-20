# UI plugin rail pages and agent state

The following additions extend plugin bridge v1. Existing manifest fields and
request/response envelopes keep their meanings. New plugins require a host
that recognizes the new capabilities; older hosts reject their manifests.

## Page contribution

`contributes.railPage` accepts `{title, entry, agentStateEvents?}`. Title is
bounded to 64 characters and entry is a safe bundle-relative path of at most
256 characters. `ui.rail-page` must be declared and approved. The host mounts
the sandboxed iframe only while selected. `agentStateEvents:true` additionally
requires `agent.state.read`. No same-origin, navigation or filesystem privilege
is added to the iframe. Plugin routes are transient, not saved to sessions.

## Snapshot read

`agent.state({workspaceId?, includeActivity?})` is an experimental hosted-UI
plugin RPC, not an external pipe/MCP API. The host supplies the actual workspace;
a caller cannot select another workspace by changing params. Unbound callers
and external transports are refused. `agent.state.read` is required even in
shadow enforcement mode. With `includeActivity:true`, unrestricted
`terminal.read` is also required; scoped terminal grants do not authorize a
whole workspace's activities. Both grants are checked again after the read.

Response: `{workspaceId, panes, truncated}`. Each pane has `paneId`, `label`,
`state` (`working`, `needsYou`, `finished`, `resting`), `stashed`, and `surfaces`
containing `{surfaceId, agentName}`. Optional `activity` requires the additional
permission above. Labels come from user labels/coordinates, not terminal titles.
User labels can themselves contain sensitive information. Activity can contain
commands, filenames and search text; it is not included in base snapshots.

Membership comes from the canonical local agent roster. State comes from the
final Fleet board, including hook-running, pending-question and unverifiable
classification. Plain shells, Bots workspaces and all panes containing remote
terminals are excluded. Responses are bounded to 512 panes, 32 surfaces per
pane, 512 Unicode characters per display string and 1 MiB total. Omission due
to those limits sets `truncated:true`.

## Snapshot events

The opted-in rail frame receives an immediate read, then reads at most once
per second with one request in flight. Only changed snapshots are emitted:

```
{v:1, id:null, kind:"agent-state", epoch, revision, workspaceId,
 status:"ready", snapshot}
```

`reset` and `unavailable` statuses carry no snapshot. Consumers must discard
old data on either. Epoch changes with the port or workspace; revision is
monotonic only within that epoch. This is replacement state, not an EventBus
stream: it has no daemon sequence, history or replay. Events never include
activity. Every read runs through the permission gate. The loop stops on a
refusal/error; reopening the page retries. Page exit and reload close the old
port and timer. A workspace change invalidates pending explicit reads too.

## Navigation and installation

`pane.focus({id})` uses its existing `pane.read` gate and workspace confinement.
After a successful focus from the current rail page, the host returns to
Workspaces. Responses from an earlier page/workspace lifetime do not navigate.
The example performs this on a button click; approved plugin code can initiate
focus calls, so this is not a claim of user-gesture attestation.

Bundles are still loaded from the existing plugins directory on startup. This
API addition does not supply a store, runtime uninstall/reload, open publishing
or a teammate identity feed. See the original example at
[`examples/plugins/agent-state-page`](../../examples/plugins/agent-state-page).
