# C1 — memory-bounded terminal retention (as built)

Status: IMPLEMENTED on branch `fix-c1-worktree-retention`, three slices behind
independent kill switches (defaults on):

- **A** — SSH worktrees park like local ones; reveal paints from main's
  headless model with the relay replay as fallback (`terminalSshViewParking`).
- **B** — hidden un-parkable worktrees force-park beyond a count budget (12)
  or TTL (45 min) (`terminalHiddenWorktreeRetentionBudget`).
- **C** — hidden panes that must stay mounted demote to the minimum
  scrollback tier (`terminalHiddenScrollbackDemotion`).

The decision-gate conditions (headless-source trust, separable revertable
commits, named budget constants with sizing comments, damping conventions +
flip-loop regression tests, the test-coverage list, and the explicit
non-claim) are all reflected below. File:line cites are verified at this
branch's HEAD; prefer the symbol names over the line numbers if they drift.

**Non-claim and residual (gate condition 6):** this fix does NOT claim H1
alone reaches 3.5 GB. It bounds the retained-pane fleet, which also bounds
every per-pane accumulator. The named residual is the uncapped
`pendingSideEffects` queue (`terminal-pane/pty-transport.ts:157`, H2 in the
diagnosis) — see §4. H3 (premature ack) is already fixed at HEAD (#10012)
but absent from the 1.4.15x field builds. Companion diagnosis:
`crash-c1-heap-leak-diagnosis/C1_DIAGNOSIS.md` (other worktree, read-only).

---

## 1. Problem and mechanism (diagnosis recap)

- `Terminal.tsx:1144` adds every activated worktree to
  `mountedWorktreeIdsRef` permanently; removal only when the worktree ceases
  to exist. The set also grows without user action: agent launches
  (`launch-agent-background-session.ts:303`), sleeping-agent wakes
  (`wake-sleeping-agents-in-background.ts:83`), mobile tab subscriptions
  (`useIpcEvents.ts:1694`), CLI-driven tab creation (`useIpcEvents.ts:1767`),
  and browser-automation bootstrap leases which mount the whole worktree
  (`useIpcEvents.ts:222`).
- Pre-fix, the sole eviction lever was cold parking, and eligibility was
  all-or-nothing: `canParkTerminalWorktreeRenderers`
  (`terminal-hidden-view-parking.ts`) requires a restorable pty for EVERY
  tab, plus a watcher-coverage veto (`canWatcherCoverParkedTerminalTab`,
  `terminal-parked-tab-watchers.ts:104`). Un-parkable classes — SSH (pre-A),
  remote-runtime, null ptyIds, separator-less daemon-fail-open ids, ptys
  minted under another worktreeId (`isSnapshotBackedTerminalPty`,
  `terminal-hidden-view-parking.ts:58`), pending spawns, watcher-uncoverable
  tabs — each meant unlimited retention of the whole worktree.
- SSH bytes DO transit local main: `runtime.onPtyData`
  (`orca-runtime.ts:7484`) → `trackHeadlessTerminalData` →
  `getOrCreateHeadlessTerminal` (`orca-runtime.ts:9105`) maintains a
  ~5000-row headless model for every pty main ingests, served over
  `pty:getMainBufferSnapshot` (`src/main/ipc/pty.ts:4058`). The pre-fix SSH
  reattach path never consulted it — it painted the relay's rolling 100 KiB
  raw-byte buffer (`src/relay/pty-handler.ts:175,476-478`).
- Remote-runtime is the genuinely hard class: no bytes transit main, and the
  desktop subscribe snapshot is screen-only
  (`src/main/runtime/rpc/methods/terminal.ts:688`).

**Measured cost per retained hidden pane** (repo's own
`@xterm/headless@6.1.0-beta.287`, agent-CLI-like SGR output, steady state):

| scrollback | V8 heap (counts toward the 3586 MB ceiling) | ArrayBuffers (off-heap) |
|---|---|---|
| 5 000 rows (default) | ~2.5 MB | ~12 MB |
| 50 000 rows (max) | ~19.4 MB | ~114.7 MB |

**Honest magnitude statement.** Static H1 retention alone reaches GB scale
only with on the order of 10² big-scrollback panes (e.g. 20 SSH worktrees ×
5 agent tabs ≈ 0.4–1.9 GB). The observed multi-hour monotone climbs are best
explained as H1 × per-pane accumulators: H1 supplies an unbounded,
never-evicted pane fleet; H2 (and H3 in the 1.4.15x field builds) supply
per-pane growth that never plateaus. Bounding the fleet bounds the class —
every per-pane accumulator dies with its pane. Field fit: the zero-git OOM
bundle is an SSH workspace with 7 worktree activations — the exact "nothing
can ever park" profile.

## 2. Design as built

### 2.1 Slice A — SSH worktrees park like local ones

- **Eligibility** (`isParkRestorableTerminalPty`,
  `terminal-hidden-view-parking.ts`): an SSH-shaped pty id
  (`parseAppSshPtyId`) counts as restorable when `terminalSshViewParking` is
  on. The signal is stable by construction — it derives from the pty id
  shape plus the setting, both of which only change on real state
  transitions, so it adds no flip-loop input. Remote-runtime,
  separator-less, foreign-worktree, and null exclusions are unchanged.
- **Watcher coverage:** fact-mode parked watchers work for any pty whose
  bytes transit local main, which includes SSH; only a non-null
  `runtimeEnvironmentId` disqualifies.
- **Reveal paint** (`pty-connection.ts`, reattach path): relay `pty.attach`
  stays the liveness authority (the SSH reattach recovery chain is
  untouched). The paint prefers main's headless model over the relay replay:
  `fetchSshMainModelReattachSnapshot` fetches `pty:getMainBufferSnapshot`
  and `decideSshReattachPaintSource` (`ssh-reattach-model-restore.ts`)
  accepts only `source === 'headless'` snapshots — a 'renderer'-sourced
  snapshot serializes a mounted xterm that no longer exists after a park.
  Emptiness is judged on the COMPOSED payload (`scrollbackAnsi` + `data` +
  `pendingEscapeTailAnsi`), so an alt-screen snapshot with an empty screen
  frame still paints. Anything else degrades to the relay replay — never a
  blank paint when either source has content.
- **Empty-replay probe:** when the reattach carries no structural replay at
  all (relay restart empties the buffer), the SSH path still probes the
  model — the snapshot is prefetched before the coordinator route is chosen
  and painted inside the coordinator, so a relay restart no longer blanks a
  reveal main's model can restore.
- **CONSTRAINT — the paint is inline, never via `applyMainBufferSnapshot`.**
  That function runs its own `structuralReplayCoordinator.run`; calling it
  from `applyReattachPayload` (already a coordinator task when a replay
  exists) deadlocks on the coordinator's tail chain. The inline paint
  mirrors the daemon-snapshot branch (folded `scrollbackAnsi` + screen,
  dimension-matched resize, escape tail written last) and arms
  `setRestoredSnapshotBaseline` + `recordRendererOrderedSeq` so deferred and
  live chunks the snapshot already covers dedupe instead of double-painting.
- The passive-hibernation reattach branch (empty adopted shell with
  completed-hibernation evidence) takes its fresh-restore path before any of
  this and is unchanged.

### 2.2 Slice B — force-park retention budget

Force-park, NOT unmount-from-`mountedWorktreeIdsRef`: force-parked ids join
the existing parked set after the coverage veto
(`selectRetentionForceParkedTerminalWorktrees`,
`terminal-hidden-worktree-retention.ts`), so every downstream mechanism —
render null, watcher sync, reveal — is the ordinary parking machinery. The
only new state is the verdict itself.

- Candidates: hidden, mounted, un-parkable worktrees (ordinary parking
  doesn't cover them), excluding visible / measuring / portal-holding /
  pending-spawn ones, past the 30 s cold-park hysteresis.
- Budget: `TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT = 12` hidden un-parkable
  worktrees, `TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS = 45 min` TTL,
  evicted least-recently-hidden first. Ranking reuses
  `selectIdsBeyondHotRetain` (`terminal-hidden-view-parking.ts:188`), so the
  last-active exemption and deterministic ties hold here too: a SINGLE
  hidden un-parkable worktree never force-parks — one warm slot is the
  deliberate floor (slice C bounds it instead, §2.3).
- **Eviction exemption is per-TAB, not per-worktree.** An eviction-exempt
  tab (`isEvictionExemptTerminalTab`: a live local pty a remount could not
  reattach — daemon-fail-open separator-less ids AND ptys minted under
  another worktreeId; null/SSH/remote ids are not exempt) no longer vetoes
  its worktree. The worktree force-parks while exempt tabs keep their
  mounted panes via a per-tab exclusion mirroring the Activity-portal
  pattern (legacy watcher sync + render in `Terminal.tsx`, and
  `useTerminalTabColdParking` via the `isForceParked` prop). Exempt panes
  need no watcher (they stay mounted); sibling tabs unmount with watcher
  coverage where the transport exists. Ordinary parking eligibility is
  untouched: a worktree with an exempt tab still cannot ordinary-park,
  because eligibility requires every tab restorable.
- Best-effort capture at force-park: the existing 512 KB
  `shutdownBufferCaptures` serialization runs once per force-park episode
  before the unmount render, so snapshot-less classes still reveal
  last-known content cold-restore-style.
- Damping: the verdict follows every existing convention — computed in the
  worktree-parking effect, excluded from its own deps, set-equality guards
  returning the previous reference, strictly-positive recheck timers (the
  retention TTL joins the deadline list), and time-monotone membership for
  fixed inputs (unit-tested).
- Reveal after force-park is the app-restart experience per class: local =
  full daemon snapshot; SSH = model paint or relay replay (A); remote-runtime
  = current screen + captured tail; bells/titles flow through fact-mode
  watchers where bytes transit main, remote-runtime tabs go dark for those
  (accepted, documented loss — agent status still flows via the runtime
  graph).

### 2.3 Slice C — scrollback demotion

`selectScrollbackDemotedTerminalWorktrees` demotes the hidden panes that
stay mounted past the retention deadlines to
`TERMINAL_DEMOTED_SCROLLBACK_ROWS` (= 1 000, the minimum tier):

1. **Exempt tabs' worktrees** — past the TTL, or immediately when their
   worktree force-parks under the count budget (the exempt panes are then
   the only panes left mounted there).
2. **Spared un-parkable worktrees** — force-park candidates absent from the
   force-parked set (the last-active exemption, or slice B switched off)
   demote past the TTL, closing the single-worktree hole: one hidden
   un-parkable worktree never force-parks, but its scrollback no longer
   stays unbounded.

Demotion applies through each mounted pane's lifecycle hook
(`useTerminalWorktreeScrollbackDemoted` →
`applyTerminalScrollbackRowsToMountedPanes`) — an xterm option update only,
no remount/replay/refit/SIGWINCH. Trimmed history is gone by design; reveal
restores the configured cap for future output. Measured reclaim at 50k-row
settings: 19.4 → 1.3 MB V8 heap and 114.7 → 2.7 MB ArrayBuffers per pane.
Membership is time-monotone for fixed inputs (unit-tested): the force-parked
and past-TTL sets only grow with time and the last-active pick is
time-independent.

### 2.4 Hidden clock vs transient background mounts

Whole-worktree background mounts (browser-automation bootstrap lease at
`useIpcEvents.ts:222`, mobile mounts, agent wakes) open a ~3 s self-clearing
measure window (`scheduleBackgroundTerminalWorktreeMeasure`). The window
pauses every parking/retention/demotion verdict (all selectors skip
measuring candidates) but no longer resets `hiddenSince` — previously each
remount restarted the 30 s hysteresis and the 45 min TTL, so a periodically
re-mounted force-parked worktree never re-parked. Now the prior verdict
resumes at the next effect pass after the window closes; residual churn is
one mount/re-park cycle per external mount event, externally driven and
bounded (no render-loop surface). Visibility and Activity portals still
reset the clock. The browser-automation lease keeps its unrestricted
worktree mount: hidden browser panes mount only for unrestricted background
mounts (`backgroundMountTabIds === null`), so tab-restricting the lease
would break hidden-browser automation.

## 3. Kill switches — coupling and revert matrix

All four are optional booleans on settings read as `!== false` (default ON);
there is no DEFAULT_SETTINGS object to mirror (`src/shared/types.ts:2815`).

| switch | scope |
|---|---|
| `terminalHiddenViewParking` | master: all parking, incl. every C1 slice |
| `terminalSshViewParking` | A: SSH eligibility + model-paint upgrade |
| `terminalHiddenWorktreeRetentionBudget` | B: force-park budget |
| `terminalHiddenScrollbackDemotion` | C: demotion |

Coupling: master off ⇒ nothing parks, force-parks, or demotes. A, B, C are
otherwise independent of each other (C stopped requiring B's switch in this
branch's review pass).

Revert matrix:

| revert | resulting behavior |
|---|---|
| A off, B on | SSH rejoins the un-parkable class ⇒ force-parks past budget/TTL; reveal paints the relay replay only (the model probe is A-gated). Main's dropped-byte `pty:modelRestoreNeeded` repaint still applies. |
| B off, A on | SSH parks ordinarily; other un-parkable classes are retained unbounded again, except C's TTL demotion still bounds their scrollback. |
| C off | exempt tabs in force-parked worktrees and last-active-spared worktrees keep full scrollback indefinitely. |
| master off | pre-parking behavior: every mounted worktree retained forever. |

## 4. Retention floor — what stays mounted, and when OOM is still possible

Worst-case mounted-pane fleet with all switches on:

- up to **8** warm parkable hidden worktrees (`TERMINAL_WORKTREE_HOT_RETAIN_LIMIT`,
  ≤ 12 tabs each per the per-worktree tab cap), plus
- up to **12** un-parkable hidden worktrees inside the 45 min TTL
  (`TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT`), plus
- **1** last-active slot per cap (parkable and un-parkable rankings each
  spare the most recently hidden candidate), plus
- **eviction-exempt TABS** inside force-parked worktrees (post-review:
  tabs, not whole worktrees) — mounted indefinitely but demoted to 1 000
  rows once their worktree force-parks or passes the TTL, plus
- visible, portal-holding, measuring, and pending-spawn worktrees.

At the ~2.5 MB/pane default that floor is low-hundreds of MB in pathological
many-worktree profiles and falls with the TTL; demotion caps the
indefinitely-mounted exempt panes at ~1.3 MB heap each.

**When OOM is still possible.** The floor bounds pane count, not per-pane
growth inside it: the uncapped `pendingSideEffects` queue
(`terminal-pane/pty-transport.ts:157`, H2) still grows without bound inside
a visible or warm pane under background timer throttling and needs its own
cap + drain fix. An unbounded number of eviction-exempt tabs (mass fail-open
daemon degradation) would also stack demoted-but-mounted panes. And the
1.4.15x field builds additionally lack the H3 ack fix. The instrumentation
branch (`crash-c1-heap-leak-diagnosis` @ 57f39c369b) measures all of this in
the field and composes with this fix unchanged.

## 5. Test matrix

| coverage | status |
|---|---|
| SSH eligibility / watcher predicate / paint-source decisions (incl. composed-payload emptiness) | landed, unit (`terminal-hidden-view-parking.test.ts`, `terminal-parked-tab-watchers.test.ts`, `ssh-reattach-model-restore.test.ts`) |
| Force-park selector: budget, TTL, last-active, exemptions, idempotence + time-monotone membership (flip-loop condition 4) | landed, unit (`terminal-hidden-worktree-retention.test.ts`) |
| Demotion selector: exempt/force-parked/spared cases, TTL override, idempotence + monotone; registry notify damping; row clamp | landed, unit |
| Folder-workspace parity (worktree-shaped id equality) | landed, unit; the local parking e2e runs on folder-workspace-shaped ids |
| Local park/reveal + 25-cycle flip-loop guard | pre-existing e2e (`terminal-hidden-view-parking.spec.ts`), green |
| SSH park+reveal round-trip with model-paint depth proof (early marker beyond the relay's 100 KiB buffer) | landed, Docker-gated e2e (`ssh-terminal-parking.spec.ts`, `ORCA_E2E_SSH_DOCKER=1`) |
| Retention-budget (force-park) live e2e | follow-up: needs ≥2 un-parkable hidden worktrees (the last-active exemption shields one) — an e2e `retentionLimit` override (pattern: `terminal-parking-e2e-overrides.ts`, gated on `e2eConfig.exposeStore`) plus `terminalSshViewParking=false` on the Docker SSH rig |
| Remote-runtime live eviction e2e | follow-up (selector-level coverage landed) |

## 6. Residuals and follow-ups

1. H2 `pendingSideEffects` cap + drain (§4) — separate fix.
2. Retention-budget and remote-runtime live e2e (§5).
3. Pre-existing, unchanged: parked/evicted fact-mode watchers omit
   `onCommandFinished`/`onCommandCode*`; OSC 133;D command-lifecycle facts
   drop while parked.
4. Remote-runtime reveal depth: the desktop subscribe snapshot is
   screen-only; the runtime host already serves scrollback to mobile
   (`src/main/runtime/rpc/methods/terminal.ts:688` vs `:697`) — an RPC
   change could upgrade force-parked remote reveals.
5. Background-mount churn: one mount/re-park cycle per external mount event
   remains (§2.4); revisit only if field telemetry shows lease-driven
   thrash at meaningful cadence.
