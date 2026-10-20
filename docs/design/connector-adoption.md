# Connector adoption plan

Status: first implementation adds a Connectors rail page backed by the existing
bot-worker connector library. It supports My connections, Discover, search,
preset review, public MCP Registry discovery, create/edit, enable/disable and
removal with keys preserved.
Selected HTTP tool connections now have explicit per-session launch commands
for local macOS/Linux Claude Code and Codex shells. Browser OAuth now supports
compatible HTTP servers with dynamic registration. HTTP connectors now
have an explicit read-only server check (initialize and tools/list only).
No saved configuration is labeled authenticated or connected.

The existing src/shared/botConnector.ts contract and main/factory/connectorStore.ts
already provide persistence and worker integration. Reuse them rather than create
a parallel registry. No Bots execution logic is changed by this implementation.

Copied code in this change: normalizeUrl from the audited urlUtils.ts, stored in
src/shared/connectorUrl.ts. Catalog search behavior is adapted from
MCPBuilderPanel.tsx; UI primitives, state and actions use wmux components.
The MIT notice is included by scripts/generate-notices.mjs in the distributed
THIRD_PARTY_NOTICES file.

## Scope

Add a Connectors rail page with My connections and Discover views. Discover
covers the public registry across service types; authentication and agent
integration can then be added per provider. A listed or installed connector must
never imply that an account is authorized or that a terminal agent can use it.

## Source and attribution

Reference repository: https://github.com/LibreChat-AI/LibreChat
Audited revision: e081b566a42d3a83b8102157bd7806cf4ff63b17
Root license: MIT, Copyright (c) 2026 LibreChat.

Maximize reuse of suitable implementation and regression tests. For every copied
or adapted file, record its upstream path and revision, retain copyright and MIT
permission notices in the distributed application, and inspect file-specific and
transitive dependency licenses. Do not copy product branding or assume the root
license covers every external asset or service.

## Adoption map

| Upstream path | Adoption approach |
| --- | --- |
| client/src/components/SidePanel/MCPBuilder/MCPBuilderPanel.tsx | Adapt search, list, loading and visibility-driven refresh behavior to wmux navigation, store and i18n. |
| client/src/components/SidePanel/MCPBuilder/MCPServerDialog/ | Adapt form validation, authentication and connection sections. Inspect URL and OAuth utilities and their tests before porting. |
| client/src/components/MCP/McpOAuthDialog.tsx | Adapt browser authorization and state-driven dismissal to Electron IPC and existing dialog components. |
| packages/api/src/mcp/oauth/OAuthReconnectionTracker.ts | Reuse the timeout/backoff concepts and portable code after reviewing identity keys and timer boundary behavior. |
| packages/api/src/mcp/oauth/tokens.ts | Port credential-binding, refresh and teardown behavior behind a wmux credential-store interface; do not import the database stack wholesale. |
| packages/api/src/mcp/__tests__/MCPOAuth*.test.ts | Adapt applicable expiration, callback, refresh race and storage failure cases to the local runtime. |
| e2e/specs/mock/mcp-oauth-readiness.spec.ts | Reuse readiness scenarios with a controlled local test provider. |
| e2e/specs/mock/mcp-oauth-resume.spec.ts | Reuse resume scenarios with a controlled local test provider. |

The audited UI imports Recoil, React Router, LibreChat authentication hooks and
@librechat/client. Its token layer imports LibreChat data schemas, tenant context
and flow leases. These dependencies make direct whole-component integration more
expensive than adapting their useful behavior to wmux.

## wmux integration

- Follow DESIGN.md for the rail page and existing theme tokens.
- Keep the existing sandboxed UI PluginHost protocol intact. Agent connectors
  require a separate connection service rather than extending iframe trust.
- Separate catalog metadata, installed configuration, account authorization,
  connection health and per-workspace/per-agent enablement.
- Keep credentials in the main process behind OS-backed storage; expose status
  and account labels, never tokens, to the renderer.
- Bind authorization callbacks to the pending attempt and connector. Disconnect
  invalidates pending callbacks and prevents a late refresh from restoring access.
- Distinguish a temporary network/storage failure from revoked authorization.
- Integrate supported terminal agents through explicit adapters. Verify agent
  tool discovery before claiming a connection is usable; report restart needs.
- Gmail requires a verified provider/backend and OAuth registration decision;
  a Gmail catalog card alone does not provide Gmail tools. Do not reuse private
  ChatGPT or Claude connector endpoints or credentials.

## Delivery checks

1. Implement the page and connection service together with a local test provider.
2. Verify authorization success, cancellation, timeout, stale callbacks, token
   refresh, disconnect, application restart and agent tool discovery.
3. Add the first real service once its provider and authorization path are ready.
4. Run repository verification and independent code review before publishing a
   PR. Include the required changelog fragment.


## HTTP discovery follow-up

The server check uses the installed MCP SDK against the saved endpoint, with
credentials resolved only in main. It never executes a tool or a stdio process.
Redirects are refused, each response is limited to 2 MiB, discovery is capped at
16 pages / 1024 tool names, and the operation has a 10-second deadline. Four
checks may run concurrently, at most one per connection. Disposing the IPC
handlers aborts in-flight work. An edited/removed connection or rotated key
invalidates a late success. Results stay in the page, never in the registry;
a page reload does not claim a server is still reachable.

Live local HTTP fixtures exercise discovery, authorization refusal, redirect,
timeout, repeating pagination and oversized responses. IPC tests cover the
main-window boundary, missing keys, overlapping calls, rotation, deletion and
shutdown. No real user account is contacted by these fixtures.

## Ordinary terminal integration audit

The existing buildWorkerMcpConfig / buildWorkerSettings and Codex worker
configuration paths enforce bot-specific launch isolation. Copying those launch
settings into ordinary terminals would also change the owner's MCP visibility
and hook policy. The terminal adapter accepts an explicit connection
selection for a new terminal agent session, keep the owner's existing servers,
and grants access only to that selection through the local gateway. Do not rewrite global
CLI configuration automatically or mutate already-running sessions. The
existing MCP registration registry configures wmux itself, not arbitrary
connectors. A successful server check is not evidence of session tool access.

## Public registry discovery

Discover now searches the official public MCP Registry by server name and
paginates its latest active versions. This broad catalog is not limited to mail
or the two bundled presets. The fixed endpoint is
https://registry.modelcontextprotocol.io/v0.1/servers; requests carry only the
search and pagination cursor, never account keys or workspace details. The
main-window IPC boundary limits concurrent requests to four. Fetches refuse
redirects and have a 10-second deadline and 4 MiB response cap.

Entries retain their source repository, version and compatible remote URLs.
Package-only entries remain visible for manual setup; package commands and
manifest credentials are never imported or executed. Selecting a remote creates
an unsaved, disabled draft with empty tool permissions and no bot scope. The
existing configuration dialog remains the review step. Listing a service does
not prove authorization, reachability or ordinary terminal session integration.
Provider-specific setup and wider terminal transport/platform support remain follow-ups.

Registry metadata is consumed through its public API, not copied implementation
code. LibreChat's MIT license applies to the specifically attributed adapted
code, not to every service, package or repository listed by the registry. Those
providers retain their own licenses and account requirements.

## Implementation and license inventory (2026-10-20)

This is not a completed import of every reusable LibreChat feature. The adoption
map above lists candidates, not completed ports.

| Capability | Current status | Implementation provenance |
| --- | --- | --- |
| Connector page, search, list and loading states | Implemented | LibreChat UI behavior adapted to wmux components; MIT attribution retained. |
| URL normalization | Implemented | Only normalizeUrl copied from the pinned urlUtils.ts; function behavior unchanged. Other exports were not copied. |
| Configuration, secrets references and bot scope | Existing wmux functionality reused | No LibreChat persistence or authentication stack imported. |
| Public registry browsing and pagination | Implemented | wmux implementation consuming public metadata; listed server source code is not bundled. |
| HTTP initialize/tools/list check | Implemented | Existing @modelcontextprotocol/sdk 1.32.1 dependency (MIT); existing SDK notice retained. |
| Browser OAuth, callback validation and cancellation | Implemented for compatible HTTP servers | Existing MIT MCP SDK plus wmux loopback callback and IPC. |
| Token refresh and disconnect races | Implemented for server checks | Existing MIT MCP SDK plus wmux encrypted store; no automatic background retry. |
| Ordinary-terminal agent adapters | HTTP tools via explicit copied launch command on macOS/Linux | wmux local gateway; no worker guard or global CLI configuration imported. |
| Package installation and provider-specific account setup | Not implemented | Per-package license and provider requirements must be checked before incorporation. |

For the current copied function, the pinned upstream source has no separate
file-level license override. The upstream MIT license and copyright are preserved
verbatim in src/renderer/components/Connectors/LICENSE.LibreChat and emitted into
THIRD_PARTY_NOTICES. The generator records upstream paths, revision, local files
and modification scope. forge.config.ts includes THIRD_PARTY_NOTICES in packaged
app resources. Attribution must remain even when product copy omits competitor
names. No branding assets were imported and this connector branch adds no npm
dependencies relative to its base.

Release checks: run node scripts/check-licenses.mjs and
node scripts/generate-notices.mjs --check. These validate repository license
policy and notice freshness, not the license or service terms of every registry
entry. Before adding more upstream files, inspect their file-specific notices,
assets and dependency closure, then update this inventory and distributed notices.
Do not describe unreviewed packages, private provider endpoints or future ports
as license-cleared merely because LibreChat itself uses MIT.

Audit result for this checkout: all 251 production packages passed the existing
policy, including explicit pre-existing exceptions for @anthropic-ai/claude-agent-sdk
and its platform binaries under Anthropic proprietary terms. This is not an
all-MIT dependency tree. This connector change introduces no new exception;
license-allowlist.json remains unchanged. Notice generation reported zero missing
license texts. A packaged installer was not built as part of this notice-only check.

## Browser OAuth implementation

The main process uses the already-installed MIT MCP SDK for discovery, dynamic
client registration, PKCE and token exchange/refresh. No further LibreChat code
was copied. Compatible providers can use dynamic registration, or the owner can
supply a registered OAuth client with an exact issuer and token-endpoint pin.
The owner registers the displayed fixed loopback callback for a supplied client.
wmux does not ship shared provider credentials or a hosted metadata document.

An explicit sign-in opens the system browser after binding a loopback listener
(ephemeral for dynamic registration, owner-selected port for a registered client). The listener validates the host, callback path, unique parameters,
random state and authorization issuer, and consumes a callback once. Discovery
requires metadata issuer matching the discovered authorization server. Remote
servers cannot direct HTTP discovery to a local service. Requests refuse
redirects, have a 10-second network deadline and a 1 MiB response limit. An
interactive attempt expires after two minutes; refresh has a 15-second deadline.

Client information and tokens remain in main and are saved together using the
existing Electron safeStorage crypto adapter in one 0600 encrypted file per
connection, under connector-oauth. No plaintext fallback is allowed. Credentials
are bound to the exact saved resource URL, and the SDK's issuer binding is
preserved. A record without an advertised expiry is conservatively refreshed
after five minutes. Refresh preserves a previously issued refresh token when a
successful response omits a replacement. A failed refresh never falls back to
an expired access token, and never opens a browser implicitly.

Cancellation, disconnect, shutdown and configuration changes invalidate pending
writes. Disconnect deletes local authorization; it does not claim provider-side
revocation. OAuth grants authorize server checks and explicitly prepared local terminal
gateways; they are not wired into Bots. Server health, saved configuration and account
authorization remain separate statuses. Provider-specific account E2E and
automatic pane launch, Windows/WSL and stdio terminal adapters remain outstanding.

Local HTTP integration fixtures cover PKCE, callback replay/state/issuer,
restart and token refresh, refused refresh, cancellation, deadline, late response
after disconnect/removal, unavailable encryption and persistence failure. These
fixtures do not access real accounts. Main-frame IPC and renderer cancellation
are tested separately.

## Explicit ordinary-terminal launch

A configured, enabled HTTP connection with selected tools can prepare a Claude
Code or Codex launch command. The user pastes it into a new local macOS/Linux
shell. This does not mutate an existing agent or global CLI settings, add worker
guards, enable permission bypass, or invoke a model from wmux. Each command adds
an instance-local MCP server under a connection-specific wmux namespace. Upstream
API keys, access tokens and refresh tokens never enter the command or CLI config.

A loopback MCP gateway requires a random 256-bit bearer header valid for one hour
while wmux remains open. The copied command names a private, single-use launcher;
it contains no gateway bearer. The launcher passes the bearer through a dedicated
environment variable, referenced by a private Claude JSON config or Codex's
bearer_token_env_var. It deletes itself before exec; lease expiry and app cleanup
remove the configuration directory. These files are owner-only (directory 0700,
JSON 0600, launcher 0700). Same-OS-user processes can still inspect private files
or agent environments: this is not an OS sandbox boundary. Before first use, the
launcher must itself be treated as a temporary authority and not shared.
Clipboard contents are cleared after a minute using the existing ephemeral
clipboard API. Up to eight gateways may be active. The gateway rejects foreign
Host, browser Origin, unexpected paths and non-POST requests; bounds request
size, response size and concurrency; and verifies the saved connection and
OAuth revocation revision before upstream access and result delivery. All
requests retain the exact configured endpoint and refuse redirects. Authorization
refresh occurs in main, without invalidating an otherwise current gateway.

The MCP surface exposes only tools/list and tools/call. Both enforce the saved
tool policy. Resources, prompts, subscriptions and elicitation are not exposed.
There is no automatic retry of a tool call; a failure may follow a service-side
operation, and the error tells the caller to check before retrying. Changing,
disabling or removing a connection, or disconnecting its OAuth account, prevents
subsequent gateway access. Expiry or app shutdown closes the gateway.

Local SDK-to-gateway-to-HTTP fixtures verify discovery, allowed/blocked calls,
credential isolation, browser rejection and revocation. The installed Codex CLI
accepted the generated TOML server override in an isolated CODEX_HOME with one
server and no model invocation. Installed Claude Code 2.1.304 and Codex CLI 0.163.0 were then exercised against a local fixture
through the production launcher, gateway and upstream transport. Each model made
one probe tool call and returned the fixture nonce; neither printed the gateway
bearer, and all upstream requests carried the expected fixture-only header.
Claude used a private JSON config with environment expansion; Codex used
bearer_token_env_var. Real provider-account E2E remains a release check. Windows/WSL, stdio, multi-selection in one
launch, automatic pane creation and non-tool MCP surfaces are not implemented.

Read-only provider discovery check (2026-10-20): the public protected-resource
and authorization-server metadata at https://mcp.linear.app/.well-known/oauth-protected-resource,
https://mcp.linear.app/.well-known/oauth-authorization-server,
https://mcp.notion.com/.well-known/oauth-protected-resource and
https://mcp.notion.com/.well-known/oauth-authorization-server advertise matching
issuers, dynamic registration, S256 and authorization-response issuer support.
No clients were registered and no accounts were authorized during this check;
metadata compatibility is not provider account E2E evidence.

## Authorization boundaries and limitations

The gateway requires its own bearer header. Its URL, IPC response, copied command
and CLI arguments do not contain that bearer. A private single-use launcher
provides it through an environment variable. Tests verify file permissions,
argument contents, consumption of the launcher and isolation between leases.
The bearer is present in the agent's environment: an environment dump can put it
in a transcript. Processes running as the same OS user are not isolated by this
design. Native pane creation and process-bound revocation are not implemented;
a lease lasts up to one hour.

OAuth discovery, registration, exchange and refresh use a bounded native HTTP(S)
transport. Destination validation runs inside the socket's DNS lookup, and the
socket uses those exact answers without another resolution. Private, loopback,
link-local, mapped and transition addresses are rejected. The only local
exception is the same origin of an explicitly configured loopback connection.
Private LAN/intranet OAuth is unsupported. Redirects are prohibited.

Library mutation reconciles credentials synchronously. Removal, static credential
changes and observed endpoint edits revoke access even while the keychain is
locked. An unreadable library skips cleanup. Transient secure-storage, directory
listing and decryption failures preserve encrypted records; token access still
fails closed. Startup reconciles orphaned records when the records directory can be listed.

Interactive authorization pauses before client registration and browser launch.
It shows the resource receiving access, issuer and browser authorization origin.
Approval is bound to the attempt by a random ID. Refresh retains the stored
issuer and does not prompt or switch issuer implicitly. The consent UI can show
an expired approval until the next action; main rejects stale approval IDs. The
consent and browser stages share a two-minute timeout.

Unused launchers retain their lease until expiry or app cleanup. Crash leftovers
have dead credentials but are not swept automatically. Alias-only agent installs
are not resolved by the private POSIX launcher.

Real provider-account E2E remains unverified. Installed CLI-to-gateway tests used
only a local probe fixture. The library observer does not modify Bots worker
execution. The feature adds no runtime dependency or license exception; source
attribution and distributed notices above remain required.


## Reviewed service recipes

The Discover page includes 24 vendor-hosted HTTP recipes in addition to the two
existing GitHub/filesystem presets. `src/shared/connectorServices.ts` records each
endpoint, official setup source, category, and registration prerequisite. These
are original endpoint configuration data, not copied vendor implementations.
Vendor service terms and account eligibility still apply; hosted services are
not represented as MIT software. Existing MIT code attribution is unchanged.

The recipes cover Gmail, Google Calendar, Drive, Docs, Sheets, Slides, Chat,
Contacts, Classroom, Slack, Notion, Linear, Atlassian, Figma, Asana, Sentry, Stripe,
Vercel, Supabase, Cloudflare, Canva, HubSpot, PayPal Sandbox, and Dropbox. Google
requires the Workspace Developer Preview and a configured Cloud project; Slack
requires an eligible registered app. There is no claim that these provider
accounts have been authorized or tested. Other providers remain discoverable
through the public registry or a custom connection.

Setup flow: review the provider's instructions, configure/save the disabled
recipe, explicitly enable it, sign in (Advanced sign-in for pre-registered
clients), check the server, select tools, and review/save their permissions.
New recipes grant neither tools nor bot scope. Checking a server returns bounded
tool names without calling any tool. Selection opens the existing review dialog;
it never saves permissions on a checkbox change. Dotted tool names are accepted
so namespaced provider tools can be listed explicitly for HTTP connections with
no bots selected. Dotted allow/deny policies are refused for bot-scoped or stdio
connections and filtered out of worker selection, preserving the worker
adapters' existing CLI-safe-name and literal-regex assumptions.

Pre-registered clients have a fixed loopback callback port, issuer, token
endpoint, optional scopes and token authentication method. Both issuer and
exact token endpoint are pinned before any client credential is submitted.
Client credentials and configuration are stored only inside the encrypted OAuth
record after successful sign-in and removed on disconnect. Google-style offline
access adds access_type=offline and prompt=consent to the authorization URL.
Refresh reuses the same pins and authentication method, without browser fallback.
An occupied callback port fails closed. Provider client rejection never falls
back to registering or presenting that client to another issuer.

Microsoft 365 and providers requiring tenant-specific endpoints, proprietary
client approval, unsupported auth grants or a local server are not claimed as
ready-made recipes. No private ChatGPT/Claude service endpoint or credential is
reused. Real account E2E remains a separate owner-authorized check; fixtures test
confidential-client exchange, refresh, consent, destination pinning and secrecy.
