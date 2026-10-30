# F2: Org model (departments, workspaces, members)

**Goal:** the org's structure is one durable, versioned description: which departments exist, which workspace each one lives in, who coordinates it, and who its members are. Every other feature reads this description, and none invents its own.

**Steps:**

1. Define the schema in `src/org/org-model/schema.ts`.
2. Define one file per department in `config/org/departments/`, and one `org.json` that lists them.
3. Load and validate the file at instance start (F1 isolation check runs first).
4. Expose the model read-only over the existing RPC surface, so agents can query it.

## Current state (verified)

- 3.38.1 has a company model: `CEO -> departments -> members` (`src/company/types.ts`, `src/company/core/builtinTemplates.ts`). Templates are "Full-Stack Team", "Startup MVP" and "Code Review Squad". Each department has `leadName` and `members`.
- The company model has no notion of a per-department workspace, no per-department coordinator distinct from `leadName`, and no shared stream.
- 3.38.1 has `company.*` RPCs for create, addDept, addMember, sendDept, sendMember, and similar (`src/main/pipe/handlers/company.rpc.ts`).
- Upstream removed the department routing used by `company_a2a_send` (PR #1165). The removal is in 4.x, not in our base, so it does not affect us directly. It does show that upstream does not plan to keep this shape.

## Gap

- No mapping from a department to a wmux workspace. Today the whole company lives in one workspace (the MERIDIAN workspace has all eight agent surfaces).
- No schema version, so changes to the model break silently.
- The `company.*` RPCs mutate state through the UI. Agents cannot read the model without the renderer.

## Design

- **Department** = a stable ID, a display name, one workspace reference, one coordinator reference, and a member list. Member references are agent identities (F3 defines them).
- **Workspace reference** = a workspace name following the pattern in FOLDER-STRUCTURE.md section 5. The mapping from department to workspace ID is written back after creation, so renames do not break routing.
- **Versioned file.** `org.json` carries `schemaVersion`. The loader refuses an unknown version.
- **Coexistence.** The 3.38.1 `company.*` RPCs stay. The org model is a new source of truth that the company RPCs read from, not a second store. Migration of existing company state is a one-time copy, recorded in the ledger.

## Folder changes (fork)

- `src/org/org-model/` (new): `schema.ts`, `load.ts`, `validate.ts`, with tests.
- `config/org/org.example.json`, `config/org/departments/*.json` (new, templates).

## Open decisions

- The department list (LEDGER L-10).
- Whether member identities are card IDs or agent names (depends on the card system used by the fleet; see F6).

## Verification

- Load a sample `org.json` with three departments. The loader returns no errors.
- Load a file with a missing coordinator. The loader fails with a named field.
- The company RPCs return the same member list before and after the org model is loaded.

## Status

Designed. Not built. The schema is a draft.
