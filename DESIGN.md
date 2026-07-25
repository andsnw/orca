# C1 fix design — memory-bounded terminal retention

Status: APPROVED at decision gate (A+B+C, D deferred) with binding conditions:
(1) parked-SSH reveal must verify per-pty-class that a main-side headless
emulator actually backs `pty:getMainBufferSnapshot` (accept only
`source === 'headless'`); degrade to relay replay otherwise — never a
blank/stale paint. (2) Separable commits A→B→C, each independently
revertable behind its own kill switch; A/B default ON. (3) Budget defaults
12-hidden + 45-min TTL as named constants with sizing comments grounded in
the measured 2.5–19 MB numbers. (4) Preserve the damping conventions in §1.2;
add a flip-loop regression test for eviction. (5) Tests must cover SSH
park+reveal round-trip fidelity, folder workspaces, remote-runtime eviction,
fail-open exemption, and C demotion+restore. (6) Explicit non-claim recorded
below.

**Non-claim and residual (gate condition 6):** this fix does NOT claim H1
alone reaches 3.5 GB. It bounds the retained-pane fleet, which also bounds
every per-pane accumulator. The named residual is the uncapped
`pendingSideEffects` queue (`terminal-pane/pty-transport.ts:157`, H2 in the
diagnosis) — it still grows without bound inside a *visible or warm* pane
under background timer throttling and needs its own cap + drain fix as a
follow-up. H3 (premature ack) is already fixed at HEAD (#10012) but absent
from the 1.4.15x field builds.
All cites at HEAD `9eff3728a3` in this worktree. Companion diagnosis:
`crash-c1-heap-leak-diagnosis/C1_DIAGNOSIS.md` (other worktree, read-only).

---

## 1. Confirmed mechanism at HEAD (Phase-1 re-verification)

The H1 mechanism holds at HEAD exactly as diagnosed at v1.4.155; the only
change to the two core files since v1.4.155 was #10179 and its revert.

- `Terminal.tsx:1018` — `mountedWorktreeIdsRef.current.add(...)` on every
  activation, permanently; removal only when the worktree ceases to exist
  (`:1031-1037`). Both render paths mount panes for every id in the set
  (`:2071` split, `:2124` legacy).
- The mounted set also grows **without user action**: background mounts from
  agent launches (`launch-agent-background-session.ts:303`), sleeping-agent
  wakes (`wake-sleeping-agents-in-background.ts:83`), mobile tab subscriptions
  (`useIpcEvents.ts:1694`), CLI-driven tab creation (`useIpcEvents.ts:1767`),
  and browser-automation bootstrap leases which mount the **whole worktree**
  with no tab restriction (`useIpcEvents.ts:222`). This is what survives
  `renderer_recovery_reload` and re-populates the set overnight.
- Sole eviction lever is cold parking, and eligibility is all-or-nothing:
  `canParkTerminalWorktreeRenderers` (`terminal-hidden-view-parking.ts:70-108`)
  requires `isSnapshotBackedTerminalPty` (`:56-68`) for EVERY tab. HEAD adds a
  further veto absent from the v155 diagnosis: a worktree with any
  **watcher-uncoverable** tab never parks (`Terminal.tsx:875-880`).
- Un-parkable classes at HEAD (each ⇒ unlimited retention of the whole
  worktree): SSH ptys, remote-runtime ptys, null ptyIds
  (`ssh-target-cleanup.ts:127` mints exactly that), separator-less
  daemon-fail-open ids, ptys minted under another worktreeId
  (`terminal-hidden-view-parking.ts:56-68`), tabs with pending
  startup/activation spawns (`:99-106`), and any watcher-uncoverable tab
  (`terminal-parked-tab-watchers.ts:92-109`).
- Caps compose per-worktree: `TERMINAL_TAB_HOT_RETAIN_LIMIT = 12` is enforced
  per overlay-layer instance, i.e. per worktree
  (`use-terminal-tab-cold-parking.ts:136`), on top of the 8-worktree warm cap
  — and neither cap sees un-parkable worktrees at all.

Corrections to the established framing (things the fix should NOT build for):

1. **The legacy non-split path is effectively dead.**
   `anyMountedWorktreeHasLayout` synthesizes a layout from merely having one
   group (`split-group-mount.ts:7-23,33-45`); groups are created on first
   `addTab` (`tab-group-state.ts:57-80`) and hydration always writes both
   (`tabs-hydration.ts:271-284`). The legacy branch is reachable only when
   every mounted worktree has zero tabs and zero groups. Per-tab-parking
   parity for it, or retiring it, is not a C1 lever (kept out of scope).
2. **No parking flip-loop ever existed.** The first parking attempt
   (`1ab6b87c7f`, reverted `8eee59c084`) was pulled for going *silent* (no
   byte watchers), not for oscillating. The two real React #185 loops
   (`9038a78d37` overlay measure↔fit; `e8452c8c50` Activity portal
   reconciliation) are adjacent, and their post-mortems define the damping
   conventions any new lever must keep: verdict excluded from its own effect
   deps (`Terminal.tsx:911-921`), set-equality bail-outs returning the
   previous reference (`Terminal.tsx:153-163`), strictly-positive recheck
   delays (`terminal-hidden-view-parking.ts:269-284`), and monotone
   consumption edges. The one genuinely bidirectional verdict input is
   Activity-portal readiness; the watcher-coverage veto reads module state
   written at unmount (`terminal-parked-watcher-registry.ts:25-35`) and sits
   in no dep array.
3. **SSH exclusion is about reveal fidelity, not observability.** Fact-mode
   parked watchers subscribe main-computed side-effect facts and work for any
   pty whose bytes transit local main — which includes SSH; only a non-null
   `runtimeEnvironmentId` disqualifies
   (`terminal-side-effect-facts-handler.ts:44-62`). And main already
   maintains a headless emulator (~5000-row model) for every pty it ingests,
   SSH included: `runtime.onPtyData` → `trackHeadlessTerminalData` →
   `getOrCreateHeadlessTerminal` (`orca-runtime.ts:7484,7528,9026-9044,
   9105-9113`), served over `pty:getMainBufferSnapshot`
   (`src/main/ipc/pty.ts:4058-4116`). **The SSH reattach path simply never
   consults it** — it paints the relay's rolling 100 KiB raw-byte buffer
   (`src/relay/pty-handler.ts:175,472-480`) after an unconditional clear
   (`pty-connection.ts:7378-7391`).
4. **Remote-runtime is the genuinely hard class.** No bytes transit main (no
   emulator, no facts); the desktop subscribe snapshot is screen-only —
   `scrollbackRows: 0` (`src/main/runtime/rpc/methods/terminal.ts:682-696`)
   — even though the runtime host holds scrollback and serves it to mobile
   (`:697-714`).

## 2. Quantification (what a retained hidden pane actually costs)

Measured empirically with the repo's own `@xterm/headless@6.1.0-beta.287`
(agent-CLI-like SGR output, 200 cols; steady state after scrollback wrap):

| scrollback | V8 heap (counts toward the 3586 MB ceiling) | ArrayBuffers (off-heap, invisible to `usedJSHeapSize`) |
|---|---|---|
| 5 000 rows (default) | ~2.5 MB | ~12 MB |
| 50 000 rows (max) | ~19 MB | ~115 MB |

Cost plateaus once scrollback wraps (120k lines into a 50k buffer = same as
60k). On top of the xterm graph, each mounted-but-hidden pane retains: all six
addons, ResizeObservers, React fiber tree, the PTY IPC subscription, a
background write queue capped at max(2 MiB, rows×120) chars — up to ~6 MB at
50k rows (`terminal-scrollback-policy.ts:37-46`,
`pane-terminal-output-scheduler.ts:102,124`) — and the **uncapped**
`pendingSideEffects` array (`terminal-pane/pty-transport.ts:157`, H2), which
is per-pane closure state and grows without bound under background timer
throttling. Only worktree-level hiding releases WebGL; a tab hidden behind a
sibling in the active worktree keeps its GL context
(`terminal-visibility-resume.ts:103-137`). Nothing trims scrollback or
addons on hide.

**Honest magnitude statement.** Static H1 retention alone reaches GB scale
only with ~10⁲ big-scrollback panes (e.g. 20 SSH worktrees × 5 agent tabs ≈
0.4–1.9 GB depending on scrollback setting, plus per-pane floors). The
observed multi-hour monotone climbs and the codeg-dev 1.7 GB-in-20-min boot
burst are best explained as **H1 × per-pane accumulators**: H1 supplies an
unbounded, streaming, never-evicted pane fleet; H2 (and, in the 1.4.15x field
builds, H3 premature-ack) supply per-pane growth that never plateaus.
Bounding the fleet bounds the class — every per-pane accumulator dies with
its pane. If the gate wants a pure-H1 story, this design does not claim one;
the instrumentation branch (`crash-c1-heap-leak-diagnosis` @ 57f39c369b:
precise memory + paneTerminals census + terminalOutputQueue contributor)
confirms attribution on the next field cycle and composes with this fix
unchanged.

Field fit: the zero-git OOM bundle (`1biDRoy…`, 6.6 MB/min for 10 h) is an
SSH workspace with 7 worktree activations — the exact "nothing can ever
park" profile.

## 3. Consumers/assumptions of "mounted forever" (eviction blast-radius map)

What unmounting a pane already handles correctly (verified disposal chain:
`use-terminal-pane-lifecycle.ts:1587-1680`, `pane-lifecycle.ts:213-300`,
`pty-connection.ts:8264-8377`): PTY survives (detach, never kill,
`pty-transport.ts:906-916`); store tab entry, `tab.ptyId`, layouts, and
`capturedPanesByTabId` persist; exit observers stay registered.

What breaks or degrades if a worktree is evicted without further work:

| surface | behavior after eviction | mitigation available |
|---|---|---|
| Bells/titles/completions/PR links | dark unless a watcher covers the tab; watcher predicate today requires snapshot-backed pty (`terminal-parked-tab-watchers.ts:92-109`) | fact-mode works for SSH/local/fail-open (bytes transit main); only remote-runtime lacks the channel |
| Agent status (sidebar) | main-side `agentDetector`/OSC processing runs at ingestion regardless of panes (`orca-runtime.ts:7500-7505`); remote-runtime status flows via runtime graph | verify per-surface in tests |
| Reveal content, local daemon-backed | full daemon snapshot reattach — today's parked path (`pty-connection.ts:7892-7933`) | none needed |
| Reveal content, SSH | relay replay: last 100 KiB raw bytes, no dimension match; empty after relay restart; `SSH_SESSION_EXPIRED` → blank fresh shell (`ssh-pty-session-reattach.ts:39-81`, `pty-connection.ts:7746-7752`) | main headless snapshot upgrade (Option A) |
| Reveal content, remote-runtime | current screen only, zero scrollback | RPC change to request scrollback rows (exists server-side for mobile) |
| Reveal content, daemon-fail-open (separator-less id) | generic path fresh-spawns, **orphaning the live pty** (`pty-connection.ts:7885,8106`) | exempt from eviction, or accept + 512 KB capture painted as cold-restore |
| OSC 133;D / Command Code facts | already dropped for parked tabs today (watcher omits `onCommandFinished`/`onCommandCode*`, cf. `pty-connection.ts:2212-2234`) — pre-existing gap, unchanged | out of scope |
| Snapshot restore fidelity, folder workspaces | folder-workspace ids are worktree-shaped; `isSnapshotBackedTerminalPty` passes identically (`pty-session-id.ts:21-25`) — no special-case needed | covered by tests |
| Input during eviction | impossible (hidden worktree has no focused pane); parked-tab input path already routes `window.api.pty.write` (`terminal-parked-tab-watchers.ts:143`) | n/a |

## 4. Options

### Option A — Make SSH worktrees parkable (fidelity upgrade + eligibility)

Convert the largest un-parkable class into ordinary parked citizens.

1. **Eligibility:** extend the parking predicate so an SSH pty
   (`parseAppSshPtyId`) counts as restorable, gated on a per-pty "main model
   available" signal rather than blanket exclusion. Keep remote-runtime,
   separator-less, foreign-worktree, null exclusions unchanged.
2. **Watcher coverage:** relax `canWatcherCoverParkedTerminalTab` for SSH to
   the fact-mode availability predicate (bytes transit main). No new watcher
   machinery: fact consumers already work for SSH.
3. **Reveal fidelity:** on parked-SSH reveal, keep relay `pty.attach` as the
   liveness authority (unchanged — respects the SSH reattach recovery chain),
   but paint from `pty:getMainBufferSnapshot` (≈5000-row dimension-matched
   serialized model, incl. `pendingEscapeTailAnsi`) when it returns non-null,
   falling back to today's 100 KiB relay replay when it returns null (main
   returns null after a delivery gap when only a tail is retained —
   `src/main/ipc/pty.ts:4082-4090`). The fetch/apply/dedupe machinery exists
   (`applyMainBufferSnapshot`, `pty-connection.ts:6561-6711`; seq-bounded via
   `pendingDeliveryStartSeq`).

- **Data loss / UX:** strictly better than today's *unmount* outcome and
  bounded vs today's *retention* outcome: a re-activated parked SSH worktree
  shows ~5k rows of scrollback instead of (a) full renderer buffer at
  unbounded memory cost, or (b) 100 KiB raw replay. Bells/titles/completions
  stay live via facts. Scroll position restored as bottom-offset intent like
  local parks.
- **Flip-loop surface:** none new — same verdict machinery, one more class
  passes the existing (damped) filter. The eligibility signal must be stable
  (derive from pty id shape + a monotone capability latch, never from
  fetch-time success/failure).
- **Blast radius:** parking predicate, watcher predicate, SSH reveal paint
  path. No main-process changes required (snapshot IPC exists).
- **Rollback:** the existing `terminalHiddenViewParking` kill switch disables
  the whole lever; a class-scoped flag (`parkSshTerminals`) can gate just
  this.
- **Limit:** does nothing for remote-runtime / fail-open / foreign-pty /
  uncoverable classes; retention stays eligibility-bounded for them.

### Option B — Hard mounted-worktree budget applied BEFORE parkability (the actual memory bound)

The task's stated goal — memory-bounded rather than eligibility-bounded —
requires an eviction lever that does not consult eligibility.

1. In the existing worktree-parking effect (`Terminal.tsx:822-921`), after
   the parked-set selection, rank **all** hidden mounted worktrees (parkable
   or not) by `hiddenSinceMs`, with the same exemptions parking already
   honors (visible, measurable, portal-holding, pending startup/activation
   spawn, last-active). Beyond a budget `MAX_MOUNTED_HIDDEN_WORKTREES`
   (proposed 12) **or** past a long TTL (proposed 45 min) for un-parkable
   ones, **evict**: delete from `mountedWorktreeIdsRef`, drop restriction
   maps and `hiddenSince` (the deletion path that already exists for removed
   worktrees, `Terminal.tsx:1031-1037`), bump a revision state guarded by
   set-equality.
2. Eviction = full unmount; re-activation is identical to first activation
   after boot (reattach per class; Option A upgrades the SSH case). Start
   fact-mode watchers for evicted tabs where the transport exists (SSH,
   local, fail-open); remote-runtime tabs go dark for bells/titles (agent
   status still flows via the runtime graph) — accepted, documented loss.
3. Class carve-outs: separator-less daemon-fail-open tabs are exempt from
   eviction (remount would fresh-spawn and orphan the live pty,
   `pty-connection.ts:8106`) — they fall to Option C instead.
4. Best-effort capture at eviction: run the existing 512 KB
   `shutdownBufferCaptures` serialization (`TerminalPane.tsx:2347-2389`,
   `terminal-shutdown-layout-capture.ts:49-152`) into
   `layout.buffersByLeafId` before unmount, so even a snapshot-less remount
   paints last-known content cold-restore-style rather than blank.

- **Data loss / UX:** an evicted worktree re-activates like after an app
  restart: local = full snapshot; SSH = 5k rows (with A) or 100 KiB replay;
  remote-runtime = current screen + captured tail. Worst case is strictly
  the app-restart experience users already have.
- **Flip-loop surface:** the new verdict follows every existing damping rule:
  computed in the same effect, excluded from its own deps, set-equality
  guard, positive-delay recheck timers, and eviction is monotone (a worktree
  leaves the set; only real activation/background-mount events re-add it).
  The one cyclical risk is a periodic background-mount re-mounting an evicted
  worktree (browser-automation lease, mobile subscribe); cadence is bounded
  below by the 30 s hysteresis + TTL, and the eviction ranking must treat a
  re-mounted worktree as freshly hidden (it does — `hiddenSince` restarts).
- **Blast radius:** Terminal.tsx effect, watcher predicate (shared with A),
  capture call, new policy function + constants in
  `terminal-hidden-view-parking.ts`. No main changes.
- **Rollback:** new setting `terminalMountedWorktreeBudget` (0/absent =
  disabled) independent of the parking kill switch; ship default-on in rc,
  flip default via settings if the field disagrees.

### Option C — Scrollback demotion for eviction-exempt hidden panes

For panes that must stay mounted (fail-open class; any future exempt class):
after the hot-retain TTL hidden, set `terminal.options.scrollback` to 1 000
and back on reveal. Reclaims ~80 % of the xterm graph (19 MB → ~2.5 MB at
50k settings) with zero mount-topology change, zero coverage change, zero
flip-loop surface (no React state involved; a pane-manager pass over hidden
panes). Cost: trimmed history for long-hidden panes of that class; does not
bound pane count, fibers, or the H2 queue.

### Option D — Byte-weighted hot-retain budget (refinement, not proposed now)

Replace count caps with a byte budget using `terminal.buffer.active.length`
per mounted pane. With A+B in place the count caps stop being the binding
constraint; defer unless field data shows the warm set itself is the residual
problem. (Also candidates for follow-up hygiene, not this fix: making the
12-tab cap global rather than per-worktree; capping `pendingSideEffects`,
which is H2's own fix.)

## 5. Recommendation (ranked)

**Ship A + B together, C as the carve-out companion, D deferred.**

- A alone fixes the dominant observed class (SSH; the zero-git OOM bundle)
  with the smallest risk, but leaves retention eligibility-bounded — any new
  pty class silently re-opens unlimited retention.
- B alone bounds everything but delivers a worse SSH reveal (100 KiB replay)
  than A makes possible, and SSH is the class users will actually hit.
- A+B: retention is memory-bounded for every class, and the highest-traffic
  class re-activates at near-local fidelity. C covers the one class B must
  exempt. All three are independently kill-switchable.

Suggested landing order (single branch, separable commits): policy module +
tests → A (eligibility + watcher predicate + SSH paint) → B (budget +
eviction + capture) → C (demotion). If the gate wants a smaller first slice:
A alone is shippable and reversible; B follows in the same release train.

## 6. Test plan

Unit (vitest):
- `terminal-hidden-view-parking.test.ts` extensions: SSH ids eligible under
  the new predicate; remote/fail-open/foreign still excluded; eviction
  ranking (budget, TTL, exemptions, last-active, determinism); set-equality
  no-op on unchanged recompute (currently untested, per the flip-loop
  report); recheck-delay positivity for the new deadlines.
- Watcher predicate: fact-mode coverage accepted for SSH pty ids; remote
  runtime still uncoverable; capture-staleness on pty re-mint unchanged.
- Eviction reducer/helper: restriction maps and hiddenSince cleaned;
  fail-open exemption; capture invoked before unmount.
- SSH reveal paint: snapshot-preferred, relay-replay fallback on null, seq
  dedupe bound honored (mock transport).

E2E (Playwright, existing harness `tests/e2e/terminal-hidden-view-parking.spec.ts`
patterns + `terminal-parked-memory.spec.ts`):
- SSH-workspace park/reveal fidelity (extend the existing SSH e2e rig);
  bell/title while an SSH worktree is parked.
- Eviction: activate N>budget worktrees with streaming tabs, assert panes
  beyond budget unmount (`terminalElements` census), reveal restores, and
  memory falls (parked-memory spec pattern).
- Folder-workspace park/evict/reveal parity (project rule).
- Flip-loop guard: drive 25 evict/re-activate cycles (mirror of the existing
  25-cycle park spec `:467`), assert no React #185 and byte-for-byte restore
  where snapshot-backed.
- Legacy path: not covered (dead code; assert only that the worktree-level
  verdict still compiles it out — no new machinery).

Gates: `oxfmt --check -c .oxfmtrc.json` on changed files, oxlint, typecheck,
targeted vitest suites; no max-lines disables.

## 7. Rollout / rollback

- Three independent switches: existing `terminalHiddenViewParking` (master),
  new `parkSshTerminals` (A), new `terminalMountedWorktreeBudget` (B; 0
  disables, also disables C's TTL demotion). Defaults on in rc.
- Composes with the instrumentation branch: its `paneTerminals` census and
  precise-memory highwater directly measure this fix's effect in the field
  (expected signature: `paneTerminals.live` plateaus at the budget; heap
  staircase flattens after the warm window).
- Revert story: each option is a separable commit; B's eviction is additive
  to the parking effect and reverts cleanly; A's paint change falls back to
  the relay-replay branch which remains intact.

## 8. Implementation notes (as built — deltas and residuals)

Landed as four commits on this branch (A, B, C, plus an A paint-path fix):

1. **A paint is inline, not via `applyMainBufferSnapshot`.** That function
   runs its own `structuralReplayCoordinator.run`; calling it from
   `applyReattachPayload` (already inside the coordinator when a relay replay
   exists) deadlocks on the coordinator's tail chain. The paint mirrors the
   daemon-snapshot branch (folded `scrollbackAnsi` + rehydrate + screen,
   dimension-matched, escape tail last) and arms
   `setRestoredSnapshotBaseline` so deferred/live chunks the snapshot covers
   dedupe instead of double-painting.
2. **B is force-park, not unmount-from-`mountedWorktreeIdsRef`.** Force-parked
   ids join the existing parked set after the coverage veto, so every
   downstream mechanism (render null, watcher sync, reveal) is the ordinary
   parking machinery; the only new state is the verdict itself. Blast radius
   shrank accordingly.
3. **Last-active exemption applies to eviction too** (ranking reuses
   `selectIdsBeyondHotRetain`): a SINGLE hidden un-parkable worktree is never
   force-parked — one warm slot is the deliberate floor, matching parking
   semantics. The field profile this targets is many-worktree.
4. **Residual: empty relay replay on parked-SSH reveal.** If relay `buffered`
   is empty (relay restart), `hasStructuralReplay` is false and nothing
   paints (pre-existing app-restart behavior). When the hidden-delivery gate
   dropped bytes during the park, main's `pty:modelRestoreNeeded` marker
   fires on reveal and repaints from the model with seq dedupe — so the
   blank case is confined to relay-restart with no dropped-byte marker.
5. **Residual (pre-existing, unchanged):** parked/evicted fact-mode watchers
   omit `onCommandFinished`/`onCommandCode*`; OSC 133;D command-lifecycle
   facts drop while parked.

Test coverage vs gate condition 5:
- SSH park+reveal round-trip with scrollback-depth assertion:
  `tests/e2e/ssh-terminal-parking.spec.ts` (Docker-gated,
  `ORCA_E2E_SSH_DOCKER=1`, same lane as the other SSH relay specs) + unit
  coverage of eligibility/coverage/paint-source decisions.
- Folder workspaces: unit parity case (worktree-shaped id equality) in
  `terminal-hidden-view-parking.test.ts`; the local parking e2e already runs
  on folder-workspace-shaped ids.
- Remote-runtime eviction under B: covered at the selector level
  (`terminal-hidden-worktree-retention.test.ts`); a live e2e needs either two
  remote worktrees in the rig or a retention-limit e2e override (the
  last-active exemption shields a single candidate) — follow-up, noted here
  so it isn't lost.
- Fail-open exemption: unit-covered (`isEvictionExemptTerminalTab` + selector
  exclusion case).
- C demotion+restore: unit-covered (selector TTL/monotone cases, registry
  notify damping, row clamp); demotion applies through the same
  `applyTerminalScrollbackRowsToMountedPanes` path the existing
  settings-change e2e exercises.
- Flip-loop regression (condition 4): policy-level idempotence +
  time-monotone membership tests for both new selectors, plus notify damping
  on the demotion registry; the component-level damping conventions (verdict
  out of own deps, set-equality bail, positive-delay timers) are preserved
  unchanged.
