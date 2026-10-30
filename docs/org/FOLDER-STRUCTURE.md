# Folder structure

Three places hold the org's wmux work. Each has one job.

## 1. The fork repository (`PlayFieldMultiplier/wmux`)

Default branch `org/base-3.38.1`. The upstream tree is left as it is, and the org's own code lives in new folders, so every upstream diff stays small and reviewable.

```
wmux/                                  (PlayFieldMultiplier/wmux, default org/base-3.38.1)
├── docs/
│   └── org/                           (this design set)
│       ├── README.md                  (start here)
│       ├── LEDGER.md                  (commitments, status, evidence)
│       ├── FOLDER-STRUCTURE.md        (this file)
│       ├── research/
│       │   ├── RESEARCH-DIGEST.md
│       │   └── UPSTREAM-COMPANY-SURVEY.md
│       └── features/
│           ├── F0-fork-governance.md
│           ├── F1-instance-isolation.md
│           ├── F2-org-model.md
│           ├── F3-workspace-coordinator.md
│           ├── F4-agent-self-sufficiency.md
│           ├── F5-unified-work-stream.md
│           ├── F6-meta-roles.md
│           └── F7-config-and-launch-scripts.md
├── src/org/                           (org-owned code; new, upstream never touches it)
│   ├── instance/                      (F1: suffix constants, launch-env builder, isolation check)
│   ├── org-model/                     (F2: department and workspace schema, validation)
│   ├── coordinator/                   (F3: per-workspace coordinator role definition)
│   ├── stream/                        (F5: company-level work-item stream)
│   └── meta/                          (F6: RC keeper, login-state role)
├── config/org/                        (F7: templates, example org file)
│   ├── org.example.json
│   ├── departments/                   (one template per department)
│   └── launch/                        (launch-script templates, not secrets)
└── (all upstream folders unchanged: src/main, src/daemon, src/company, src/renderer, …)
```

Rules for this repository:

- Upstream code under `src/main`, `src/daemon`, `src/company`, `src/renderer` and `src/shared` is changed only when a feature doc says so, and each such change cites its feature ID in the commit message.
- New org code goes under `src/org/`. It may import from upstream modules; upstream modules do not import from `src/org/`.
- Every PR states the feature ID and the locked base it was tested against.

## 2. The local source checkouts (this machine)

```
C:\.______\.KADMON\.WMUX__\src\
├── openwong2kim\wmux\checkout\tag-v3.38.1\        (upstream openwong2kim/wmux, tag v3.38.1, commit 245ba5e; read-only; LOCKED; see LEDGER L-16)
└── PlayFieldMultiplier\wmux\checkout\docs-org-design-v0\   (checkout of PlayFieldMultiplier/wmux, branch docs/org-design-v0)
```

**Naming rule (Victor, 2026-10-30):** a canonical location that locks a version of the openwong2kim product is anchored under the upstream owner's folder `openwong2kim\wmux`. The product's website is wmux.app. wmux.org is a different, unvalidated product, so no path or folder name may say `wmux-org` for this product.

**Path rule (Victor, 2026-10-29): every working folder for this fork carries its org, its repo, its kind (`checkout` or `worktree`) and its branch in the path itself.** The pattern is `src\<org>\<repo>\<checkout|worktree>\<branch-slug>`, where the branch slug replaces `/` with `-`. The exact branch name is also written in this file and in `LEDGER.md`.

The locked upstream checkout is `openwong2kim\wmux\checkout\tag-v3.38.1`. The tag is in the branch slot because the checkout is detached at a tag, not on a branch. It is not edited. The org clone is `PlayFieldMultiplier\wmux\checkout\docs-org-design-v0`. Each new feature branch gets its own checkout or worktree under the same pattern.

## 3. Runtime data for the org instance

Expected layout, from the `WMUX_DATA_SUFFIX` mechanics in `research/RESEARCH-DIGEST.md` section 2. The suffix is `-wmux-app`. Confirm each path on the first launch from the `[Main] WMUX_DATA_SUFFIX=… → userData=…` log line before relying on it.

```
C:\Users\victorb\.wmux-app\            (getWmuxDir: config.json, daemon pipe, daemon token)
%APPDATA%\wmux-app\                    (Electron userData: session.json, scrollback, metadata)  [expected, verify]
\\.\pipe\wmux-app-victorb              (RPC pipe)  [expected from getPipeName, verify]
```

The org instance and the production instance must never share `session.json`. The launcher and F1 include a check for this.

## 4. Launcher and identity surfaces

```
C:\Users\victorb\.agents\
├── wmux-app.ps1                       (launcher: sets WMUX_DATA_SUFFIX on the exe itself; F1, F7)
└── (existing per-agent launchers, unchanged)
```

Per-agent launch scripts for the org's agents go in the same place, one per identity, following the rule in F7.

## 5. Workspace layout inside the org instance

Each department is a workspace. The name reads as the department's path, matching the existing naming pattern `Office-Of/<name>/AS/…`.

```
org instance
├── ws: "ORG/COORDINATION"             (company-level: one stream, org roster, status board)
├── ws: "ORG/META"                     (RC keeper, login state, quota; F6)
├── ws: "ORG/MERIDIAN"                 (MERIDIAN office: coordinator + members; F2, F3)
├── ws: "ORG/WMUX"                     (wmux fabric office: AO_WMUX and members)
└── ws: "ORG/<department>"             (further departments, each with one coordinator)
```

The exact list of departments is a decision for Victor (LEDGER L-10). The names above are placeholders.

## 6. Where the org's documents live

- **Design and code:** the fork, above.
- **Office procedures and agent definitions:** `PFM___` (the shared root). Changes go through a worktree, a branch and a PR, and merge via `pfm-merge.sh`. The root is pull-only.
- **Game and product code:** `AS\LeagueOS`, through its own worktree and PR. Do not commit to the checked-out branch there.
- **Org personal-machine config:** `C:\Users\victorb\.agents\` and `C:\Users\victorb\.claude\`. Changes there are not reviewed by PR, so keep them to launchers and wiring only.

## 7. The MERIDIAN BLUE OTTOBOT folder

- `C:\.______\.KADMON\PLAY__\FIELD_\MULTI_\PLIER_\_\AS\MERIDIAN\BLUE\OTTOBOT\_` exists and is empty. It is the bootstrap location Victor named.
- The requested `AS/WMUX/APP/_` subspace does not exist yet. Its parent is open (LEDGER L-09). Until Victor decides, nothing is created there.
