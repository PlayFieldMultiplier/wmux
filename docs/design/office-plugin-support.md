# Office plugin support

Office is contributed in #2522, following discussion #2485. Keep its rendering
and original art in that contribution. Host changes must also serve other UI
plugins, without copying Office into core or granting it special privileges.

## Installation first

Each shipped catalog entry declares its reviewed bundle files. Copy only that
list, including its README and LICENSE, into the existing private staging
directory. Reject traversal, symlinks, non-files, duplicate entries, more than
64 files or more than 8 MiB. Publish through the existing rename and approval
lifecycle. No URL installation, arbitrary directory discovery, automatic
updates or automatic approval is added.

Office catalog registration and packaged resources follow review and acceptance
of its source contribution. Its current-workspace version can be tested before
any API expansion. Check original art provenance and attribution with the author;
the submitted license alone is not proof of ownership.

## Additive API proposal: review before implementation

Keep existing workspace-bound callers and grants unchanged. An explicit
`agent.state.all({includeActivity?: false})` uses its own method-to-capability
mapping for `agent.state.read.all`; it does not weaken `agent.state` confinement.
Use the central capability and risk tables, not an extra handler-only check.
Missing or malformed declarations and untrusted plugins fail closed. Enumerate
only canonical local ordinary workspaces;
continue excluding Bots and remote panes. Include bounded workspace IDs and
display names alongside pane identities. Keep aggregate payload limits and
truncation, not a full payload limit per workspace.

Cross-workspace navigation requires its own explicit capability and canonical
host lookup; a read-all grant does not grant navigation. Resolve and revalidate
the destination immediately before switching, focusing and unstashing. Do not
trust a caller-supplied workspace ID or make existing `pane.focus` less confined.
Exact method/capability names and the atomic navigation boundary need review.

Expose need reason and reset time only from the same authoritative Fleet
classification. Unknown values stay absent. Do not infer question/error/limit
from terminal text in the plugin. Preserve the existing four-state contract.

For all-workspace events, explicitly opt in at the manifest level, retain the
one-second coalescing, bounded snapshots, single in-flight read, epoch/revision
rules and reset-on-revocation behavior. Approval remains per plugin, not per
individual
capability: adding read-all to a manifest requires a fresh approval. Revocation
means denying or disabling the whole plugin; there is no read-all-only toggle
in the current trust model. No activity text is added to this grant.

Followups: teammate events coordinated with the daemon contributor; a separate
summary-only activity capability; stable state-transition timestamps maintained
by the authoritative host, not synthesized from page mount time. These are not
prerequisites for accepting the current-workspace Office example.

## Acceptance

Review the contributor bundle and host changes before PR or merge. Verify
installation, explicit approval, page navigation, disable,
permission revocation, uninstall/reinstall, hidden-page resource use and reduced
motion. Test both stale snapshots and current-workspace changes. Keep live UI
evidence separate from synthetic snapshot harnesses. Run repository verification
and Windows installation checks. Public API expansion needs engineering review
and new permission-boundary tests before implementation.
