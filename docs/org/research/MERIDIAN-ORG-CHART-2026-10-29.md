# Meridian office org chart, as reported by MERIDIAN_BLUE (2026-10-29)

Source: MERIDIAN_BLUE, answering AO_WMUX's request (ledger L-14), posted in its own pane. IDs were read by Blue from `surface_list` at the time. AO_WMUX re-checked every ptyId and pane ID below against `surface_list` on the same day, and all match.

Scope: the Meridian office, workspace `Office-Of/MERIDIAN-0QQ/__` (`ws-4fc1b556-fa9b-4d08-baaa-55976eccff5c`). Red's workspace and other pilots' workspaces are not included.

## Coordinator

| Agent | Role | Card | ptyId | pane | Verified |
|---|---|---|---|---|---|
| MERIDIAN_BLUE | Integration steward and release authority; coordinates Blue | 🍍6♠️⬆️ | daemon-25a07915 | pane-42cc07a6 | ptyId and pane match `surface_list` |

## Blue dev fleet

| Agent | Role | Card | ptyId | pane | Verified |
|---|---|---|---|---|---|
| NIETZSCHE | Dev management and dispatch | 🍍J♣️⬆️ | daemon-daa6e69f | pane-f39f30ab | ptyId and pane match |
| BERNOULLI | Dev | 🟦🍍Q♥️⬇️ | daemon-d8085d25 | pane-86034fc2 | ptyId and pane match |
| ANSCOMBE | QA validation | unverified | daemon-2e1ec011 | pane-0ef7b88f | ptyId and pane match |
| GALILEO | Release management | unverified | daemon-3d2a6487 | pane-02dca1fd | ptyId and pane match |

## Infrastructure

| Agent | Role | Card | ptyId | pane | Verified |
|---|---|---|---|---|---|
| AO_WSL | WSL and containers | unverified | daemon-266e7317 | pane-ef11a78b | ptyId and pane match |

## Peer office (PMO)

| Agent | Role | Card | ptyId | pane | Verified |
|---|---|---|---|---|---|
| MERIDIAN_PM | PMO, peer office in the same workspace | 🍍9♠️⬇️ | daemon-41c2ea3f | pane-9eab74f6 | ptyId and pane match |

## WMUX fabric

| Agent | Role | Card | ptyId | pane | Verified |
|---|---|---|---|---|---|
| AO_WMUX | WMUX fabric specialist (this design set) | unverified | daemon-3ba794e8 | pane-498e668e | ptyId and pane match |

## Notes for the design

- **Coordinator per department.** The chart has one coordinator, Blue, for the Blue team. PMO is a peer office, not a team under Blue. Whether PMO and the WMUX fabric need their own coordinators is open (ledger L-10).
- **Unverified cards.** Blue marked the cards for ANSCOMBE, GALILEO, AO_WSL and AO_WMUX as unverified. The fork must not treat those cards as settled identity until they are confirmed.
- **Pane IDs can change.** Blue's note says so. Re-read `surface_list` before any routing; do not reuse these IDs from memory.
