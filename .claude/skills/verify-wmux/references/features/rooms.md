# Rooms (agent factory dock)

The right dock is always a workspace's room: the room's bots as chips, its threads (open questions first), the shown thread's cards in arrival order, and a composer whose role chips address a bot. An open question card is answered in place. The HQ workspace's room also pins the latest plan (Approve, Edit, Decline) and report, and shows every bot. With the factory off the dock says so and offers to turn it on (`room-factory-off`). The factory is off on a fresh profile, and its switch lives with the bot runtime, so verification seeds the factory's files in the isolated data dir.

## Sub-features

- `room-gate`: `room-dock-toggle` and `room-dock` are there whatever the factory's switch says; with the factory off the dock shows `room-factory-off` (`room-factory-turn-on`, `room-factory-settings`) instead of threads.
- `room-threads`: `room-thread-list` with `room-thread-all` first, then `room-thread-row` rows ordered open questions first, then by last card; `[data-thread-unread]` only for a known count above zero.
- `room-timeline`: `room-timeline-region` sits under one hairline below the threads, with `room-timeline-header` naming the shown thread; inside it `room-timeline` (role `log`, its own scroll) holds `room-card` rows in seq order (`data-seq`); `[data-card-reply-to]` names the card a reply answers. Opening a thread with a question that waits on you (`[data-waits-on-owner=true]`) scrolls the whole card into view.
- `room-question`: an open `question` card (`[data-card-kind=question][data-card-state=open]`) shows the decision's options (`[data-decision-option]`) and answer field; answering resolves its decision.
- `room-composer`: `room-composer-input`, `room-composer-send`, role chips `room-composer-role` (`data-role`, `aria-pressed`), result line `room-composer-status`.
- `room-hq`: in the HQ room, `hq-room` with `hq-plan` (`hq-plan-approve`, `hq-plan-edit`, `hq-plan-decline`), `hq-report` and `hq-bots`.
- `room-bots`: `room-bot-chips` / `room-bot-chip` (`data-presence`; `unknown` is a hollow ring). Empty until the bot runtime is wired.
- `factory-settings`: Settings › Factory (`factory-tab`); `factory-not-installed` when the build has no factory settings bridge.

## How to get to it (user POV)

- Settings › Agents › "Factory" (rail More › Settings, or ⌘,).
- The titlebar's "Room" button (`room-dock-toggle`) opens and closes the dock.
- The dock header's "This workspace | HQ" switch (only while an HQ is set and another workspace is active).
- No keyboard shortcut.

## Driving it with control-wmux

Preconditions:

- Baseline state on a launched instance; note the suffix and read the active workspace id from `~/Library/Application Support/wmux<suffix>/session.json` (`activeWorkspaceId`).
- `control-wmux stop` (data kept), then seed `~/.wmux<suffix>/`: `factory/settings.json` `{"version":1,"enabled":true,"hqWorkspaceId":null}` (or the workspace id for the HQ room); `factory/rooms/<ws>.jsonl`, one card per line (`version:1`, unique `id`, `seq` from 1, `workspaceId` = that workspace, `threadId` such as `general`, `pr:github.com/<owner>/<repo>#N`, `issue:…#N`, `task:<id>`, `plan:<id>`, `report:<id>`, `kind`, `at`, `actor`, `title`); for a question, a `question` card with `state:"open"` and `refs.decisionId`, plus that decision in `deck-decisions.json` (`{"<ws>":[{id, question, options, context, status:"pending", raisedAt, origin:"ask_person", threadId, handoffId}]}`). Then `control-wmux launch --suffix <same suffix>`.

- **Gate, factory off.** On a profile without the seed: `control-wmux inspect --js "({toggle: !!document.querySelector('[data-testid=room-dock-toggle]'), off: !!document.querySelector('[data-testid=room-factory-off]')})"` returns both `true` with the dock open (click `room-dock-toggle` first if it is closed). Do not click `room-factory-turn-on` here: it starts the bot runtime.
- **Open the dock.** `control-wmux click --testid room-dock-toggle`, then `control-wmux wait-settle --testid room-card`. `control-wmux inspect --js "document.querySelectorAll('[data-testid=room-card]').length"` equals the seeded card count (≤ 100, the newest page).
- **Thread order and unread.** `control-wmux inspect --js "[...document.querySelectorAll('[data-testid=room-thread-row]')].map(r => r.dataset.threadId + '|' + (r.querySelector('[data-thread-unread]')?.textContent ?? '-'))"`: the thread holding the open question is first; a thread never read shows `-`, never `0`.
- **Show one thread.** `control-wmux click --selector '[data-thread-id="<threadId>"]'`, then `control-wmux wait-settle --selector '[data-testid=room-timeline][data-thread="<threadId>"]'`.
- **Answer a question.** `control-wmux click --role button --name "<option text>"`. Read back `~/.wmux<suffix>/deck-decisions.json`: the decision is `status:"resolved"`, `resolution` the option, `resolvedBy:"human"`. The card shows `[data-card-question-waiting]` and loses its needs-you border; it flips to `state:"resolved"` in the JSONL only once the handoff router runs (bot directory and wake queue wired).
- **Post with a role chip.** `control-wmux click --selector '[data-role="verifier"]'`, `control-wmux type --text 'hello' --testid room-composer-input`, `control-wmux press --key Enter --testid room-composer-input`. The last JSONL line is a `human` card in the shown thread (`general` for All activity); `room-composer-status` names the addressee, or says no bot is on.
- **HQ room.** With `hqWorkspaceId` set to the workspace and a seeded open `plan` card: `control-wmux wait-settle --testid hq-plan`, then `control-wmux click --testid hq-plan-approve`; the plan's JSONL line is rewritten with `state:"resolved"` followed by a `Resolved: …` fact card with body `approve`.
- **Factory tab.** `control-wmux press --key Meta+Comma`, `control-wmux click --selector '[data-settings-tab="factory"]'`, `control-wmux wait-settle --testid factory-tab`; without the bot runtime's bridge `factory-not-installed` is shown and every control is disabled.

## Gotchas

- The dock gate reads `factory/settings.json` when the window opens or regains focus; seed it before `launch`, not while the instance runs.
- Card authors are named by role from `~/.wmux<suffix>/factory/bots.json` (seed profiles with `enabled:false` so nothing can wake them); an id not in that file reads "Bot". Chips stay absent until the bot runtime's bridge lists the bots.
- Do not try to enable the factory from the Factory tab in a build without the bridge; the switch is disabled by design.
- A seeded line that fails validation (wrong `workspaceId`, bad thread id shape, `seq` < 1) is dropped silently; count the rendered cards against the seed.
- Never start real bots from this recipe: a bot runtime spends tokens on the owner's accounts.
