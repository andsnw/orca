# SSH Relay PTY Backpressure

Date: 2026-07-27

Status: architecture reviewed; incremental implementation plan ready

Baseline: `origin/main` at `0edc95fa35e4b6e403e116d4e224ad35329b0159`
after rebasing this design on 2026-07-27

## Scope

This plan bounds SSH relay PTY output from the native PTY through the relay
dispatcher, SSH channel or relay socket, Electron main process, and renderer
parser. It covers:

- application-level PTY output credit;
- relay stdout and socket drain handling;
- per-client isolation, fairness, ordering, and cleanup;
- bounded frame decoding on both sides of the relay protocol;
- memory budgets, diagnostics, compatibility, tests, and rollout.

The sidebar reconnect fix in `9d3ae3adc7` is out of scope. The non-ancestor
commit `1500a92904` is design input only; it must not be cherry-picked. This
work does not change PTY input semantics, terminal-model interpretation, or
file/Git payload semantics. It does change replay transport, SSH producer
pause wiring, and bulk frame admission where they share the dispatcher sink.

## Verified baseline and migration boundary

The SSH path is not currently protected by the main pending-data bound:

1. `node-pty` calls `PtyHandler`'s `onData`. `PtyHandler` keeps the existing
   100 Ki-source-unit replay tail. The first ordinary flush waits 8 ms, a
   sustained flush continues after 1 ms, and interactive or transformed output
   may publish immediately; a turn publishes at most two 16 Ki-unit chunks.
2. `RelayDispatcher.notify('pty.data')` broadcasts each publication. The
   ordinary notification path ignores `process.stdout.write()` and
   `Socket.write()` returning `false`, so every later frame can extend a Node
   writable queue after the first saturated write.
3. Main's `FrameDecoder.feed()` drains all complete frames synchronously.
   `MultiplexerTransport` exposes neither read pause/resume nor write drain.
4. `SshRelaySession.wireUpPtyEvents` is the production SSH delivery owner. It
   calls `runtime.onPtyData()` and then sends `pty:data` directly to the
   renderer. It does not enter the `PtyPendingDataDrainQueue` installed by
   `src/main/ipc/pty.ts` for local and daemon providers.
5. Main therefore has no SSH queue record against which to calculate useful
   upstream progress. The current cumulative renderer ACK is converted to a
   delta, the SSH path commonly emits zero, and the relay's
   `PtyHandler` ignores `pty.ackData` in any case.
6. Production POSIX and Windows deployment launches the relay detached, then
   attaches the real desktop bridge through a Unix socket or named pipe.
   Dispatcher construction therefore cannot identify the usable session owner.
7. `OrcaRuntime.onPtyData` returns synchronously while headless-emulator writes
   append captured strings to an unmetered asynchronous `writeChain`.
8. Relay fs/Git chunks use `notifyBulk`/producer chains outside any stated PTY
   reserve; they can occupy the same ordered sink ahead of cancel, ACK, and
   interactive output.
9. `computeRemoteRelayDir` content-hash-scopes both daemon files and endpoints.
   Mixed deployed binaries are fenced, while a prior-version daemon can remain
   alive in its old directory after upgrade.
10. `SshPtyProvider` omits the existing producer-pause hooks, and production
    constructs `MultiplexerTransport` in both SSH sentinel handling and the WSL
    hook path.
11. Lossless remote terminal streams ACK encoded byte deltas today and retain
    only aggregate in-flight bytes; no existing record maps those bytes back to
    immutable SSH source intervals. `694363805` extracted their UTF-16
    code-unit-preserving chunker to
    `src/main/runtime/rpc/terminal-output-frame-chunks.ts`; it improves
    performance and equivalence coverage but adds no provider/token identity.
12. `1fd0f731f` routes SSH folder-workspace automation launches to their owning
    host. It does not change PTY output delivery or make folder workspaces Git
    worktrees.
13. `077561f89` moved remote terminal stream UTF-8 measurement into
    `terminal-stream-byte-length.ts`, preserving legacy flush boundaries and
    partial over-limit counts. Those encoded-byte counters remain transport
    budgets, not SSH source credit.
14. `2dac0741b` preserves ordered DEC mode 2031 subscribe/withdraw decisions
    when the current main pending-data queue drops or salvages renderer output.
    Its bounded cross-chunk scan state is projection metadata that a unified
    SSH intake must preserve; it does not settle source spans.
15. `d547e278f` adds epoch-scoped, post-delivery watermarks for mobile
    notification catch-up. That notification replay protocol is distinct from
    mobile terminal streaming; its sequence and epoch cannot identify or settle
    PTY source ranges.

This project first moves ownership of every SSH provider data event out of the
direct `wireUpPtyEvents` send and into one main delivery intake. That intake
performs runtime ingestion, desktop delivery policy, remote-consumer
fan-out, and upstream span settlement exactly once. Adding another listener is
forbidden because it would double-ingest and double-render output.

The initial 8 ms/continuation 1 ms cadence and two-write limit are scheduling
controls, not bounds. A continuous producer can currently grow the relay
writable queue, SSH buffers, decoder input, and Electron heap. The frame-header
`ack` remains transport liveness bookkeeping; it is not PTY credit and never
enters this ledger.

The falsifiable invariant is: accepted SSH relay PTY output remains bounded
across relay writable queues, SSH/socket transport, main decoding and model
admission, renderer projection, and remote consumers while every source span
settles exactly once in order. The observable failure on this baseline is that
ordinary relay PTY notifications continue after `write(false)`, main drains all
complete frames synchronously, SSH bypasses `PtyPendingDataDrainQueue`, and
headless emulator writes enter an unmetered Promise chain. A sustained SSH
producer can therefore increase relay, transport, and main memory without a
finite upstream credit owner.

Authority and delivery boundaries on this baseline are:

```text
renderer/viewer
  -> IPC or runtime RPC
  -> Electron main / OrcaRuntime
  -> SshRelaySession + SshPtyProvider
  -> SshChannelMultiplexer
  -> SSH channel / --connect bridge
  -> RelayDispatcher
  -> PtyHandler
  -> node-pty / ConPTY
```

`PtyHandler` owns native output and replay; relay dispatcher/adapters own
client writes; `SshRelaySession.wireUpPtyEvents` owns production SSH ingestion;
`OrcaRuntime` owns the headless model; `src/main/ipc/pty.ts` owns
main-to-renderer accounting; and `terminal.multiplex` owns remote-consumer
delivery. The current bug is fragmentation across those owners, not a missing
renderer-only cap.

## Required invariants

1. Protocol credit uses one canonical unit: UTF-16 code units in the
   pre-transform source span, called source units (`su`). Retained memory and
   wire queues use exact bytes and never masquerade as source credit.
2. For a negotiated token,
   `0 <= sentEnd - creditedEnd <= windowSu`; each admitted slice fits the
   remaining window, so no frame overshoot is permitted. ACKs are cumulative,
   monotonic, client/PTY/token scoped, and never exceed `sentEnd`.
3. Source-credit spans are immutable and stored in a cumulative ledger.
   Queue data may merge, split, salvage, thin, or coalesce without moving,
   copying, or destroying ledger boundaries.
4. A sink `write(false)` accepts its frame exactly once. No ordinary frame is
   written again before drain. PTY admission stops before a reserved
   control/liveness capacity is consumed.
5. A spawn/attach token remains `activating` until its metadata-only response
   crosses the sink fence, then remains `recovering` until all recovery bodies
   and the completion fence drain. No live `pty.data` is eligible earlier.
6. Data is ordered within a token. `pty.exit` follows every accepted data frame
   and cannot bypass the sink gate or activation fence. Publishing exit seals
   new data but does not retire an uncredited suffix.
7. Every open token-owned span and consumer obligation ends exactly once in
   `settled`, `transferred`, or `canceled`; a transfer may pass through the
   non-terminal `transferring` state only while its named replacement fence is
   outstanding. Records are never merely abandoned while their relay token can
   remain live.
8. Desktop, mobile, web, and agent-session consumers follow the explicit
   settlement policy below. A stalled recoverable desktop projection cannot
   freeze a healthy lossless remote view.
9. One slow additional subscriber cannot retain unbounded data or stop a
   healthy subscriber. The negotiated session owner is not torn down for one
   PTY's backlog; constructor position never grants that role.
10. When every delivery for a PTY is blocked, pause the native PTY. Resume only
    when both local and relay-wide low-water predicates hold.
11. An unexpected client loss transfers outstanding output to a bounded
    reconnect-grace owner. Normal subscriber absence retains only the existing
    replay tail and no live queue.
12. Decoder work, decoded bytes, model admission, and activation-hold turns are
    bounded. A self-imposed read or local-write pause rebases both liveness
    clocks, and control/liveness service remains bounded under PTY and bulk
    saturation.
13. Disconnect, provider replacement, renderer reload, exit, disposal, and
    workspace removal have explicit bounded cleanup. After their required
    publication, transfer, cancellation, or generation-close proof, they leave
    no open span, token, writer callback, drain waiter, timer, cursor, or paused
    PTY.
14. All counters are finite safe integers. A transformed frame requires a
    valid `rawLength`; malformed, excessive, stale, and cross-client values
    cannot create credit or crash either process.
15. The session owner is elected by an authenticated session grant and
    identified by an owner generation. It is never inferred from dispatcher
    construction, stdout, socket order, a path, `.git`, or a worktree.
16. Recovery and serialization control responses contain metadata only.
    Source-ranged recovery or snapshot bodies use bounded producer lanes and
    explicit completion fences before live delivery.
17. The required main model has bounded asynchronous admission. Relay credit
    cannot advance while data waits outside that charged admission or after an
    emulator failure.
18. Negotiated V1 has one upstream ACK owner. Renderer projection progress and
    remote encoded-byte ACKs settle ledger obligations but never emit legacy
    SSH ACK deltas.
19. Required obligations becoming terminal, cumulative ACK queueing, and ACK
    publication are three monotonic states. A write callback publishes already
    eligible credit; it never creates eligibility.
20. Desktop admission carries immutable span identity through model reserve,
    projection queue, renderer send, ACK, salvage, reload, and replacement.
    Failure either rolls back an uncommitted transaction or transfers a
    committed obligation with proof.
21. Projection drop, thinning, salvage, restore, and replay preserve current
    main's ordered terminal side-effect facts and bounded scanner state,
    including DEC mode 2031 subscribe/withdraw decisions. Pre-commit rollback
    restores the prior scanner snapshot, committed transfer moves projection
    state exactly once, and an explicit source gap resets cross-chunk state;
    none of these facts creates source credit.

## Protocol

### Architecture decision record

Decision: `PtyConsumerSession` is a shared semantic state machine, not a
universal transport protocol. The architecture gate is closed by this record.
The credit, ownership, generation, activation, and cleanup invariants below are
implementation requirements; adapters may encode them differently and may
ship independently. A relay-only `pty.getCapabilities` followed by
`pty.negotiateClient` is rejected because it would create a second readiness
authority beside the existing authenticated handshakes.

The common state machine accepts only:

- an authenticated principal and owner-eligibility decision from the adapter;
- a consumer generation and optional capability offer/grant;
- a subscription/delivery identity and close reason;
- an adapter-provided publication fence.

It does not authenticate sockets, parse frames, own sentinel/residue bytes,
wait for stream drain, prove reconnect credentials, or define remote-runtime
encoded-byte ACKs. Those remain adapter responsibilities. The semantic input
and output may be represented as:

```ts
type PtyConsumerSessionHello = {
  clientInstanceId: string
  requestedRole: 'session-owner' | 'subscriber'
  resume?: {
    ownerGeneration: number
    ownerLease: string
  }
  capabilities?: {
    outputFlowControl?: { versions: [1]; requestedWindowSu: number }
  }
}

type PtyConsumerSessionGrant = {
  serverBuildId: string
  clientGeneration: number
  role: 'session-owner' | 'subscriber'
  ownerGeneration?: number
  ownerLease?: string
  capabilities?: {
    outputFlowControl?: { version: 1; windowSu: number }
  }
}
```

These types are not wire schemas. Authentication produces a transport-bound
principal and `allowSessionOwner` before the state machine sees the offer. A
request field cannot self-promote a client. The state machine performs
generation allocation, owner replacement, capability intersection,
publication fencing, and close cleanup; the adapter proves identity, carries
the semantic fields, and calls the fence.

The reviewed decision preserves the existing connection machinery:

| Path                                 | Authentication and identity                                                                                | Shared-session binding                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Local in-process provider            | trusted main-process construction                                                                          | instantiate semantics directly; no RPC or capability probe                                                |
| Local daemon                         | token-authenticated `HelloMessage`, stable `clientId`, paired control/stream sockets, and `daemonIdentity` | control hello stores an optional offer; stream hello response publishes the grant after pairing           |
| SSH relay socket/named pipe          | private endpoint credential validated by `--connect` before its sentinel                                   | first framed `pty.openClient` carries the optional offer; its response is the provider-readiness fence    |
| Direct SSH stdio and WSL child stdio | launch-bound ephemeral nonce consumed by the relay adapter                                                 | first framed `pty.openClient` proves the nonce and carries the offer; its response is the readiness fence |
| Remote-runtime server                | paired-device/E2EE identity and connection ID                                                              | adapt `terminal.multiplex` subscriptions; never issue SSH owner leases                                    |

Current direct stdio and WSL have a one-way sentinel, not a bidirectional
pre-dispatch handshake. The reviewed SSH binding therefore chooses one
mandatory post-sentinel `pty.openClient` request for every SSH adapter; there
is no remaining readiness-vs-request choice. After extracting the exact
sentinel and residue, main sends this as the first framed request and prohibits
spawn, attach, or ordinary dispatch until its response validates. The relay
adapter queues later decoded frames behind the session response's write
callback, so an eager next request cannot race activation. Main marks the
provider ready only after receiving the valid response.

Detached `--connect` first reads the version-scoped endpoint credential and
authenticates its Unix-socket/named-pipe bridge before emitting its sentinel.
The adapter converts that proof into a principal and
`allowSessionOwner = true`; `pty.openClient` carries no secret to the generic
RPC handler. Direct ssh2, system SSH, and WSL launches receive a safely quoted
one-use nonce from their existing platform-specific command builder. The
pre-dispatch adapter consumes and strips the nonce from `pty.openClient`; a
manual relay without valid proof is subscriber-only. The nonce expires on the
first accepted open or process exit.

The review compared sentinel extension and the single request against one
readiness authority, no first-spawn race, authenticated owner replacement,
response publication fencing, reconnect idempotency, exact residue transfer,
and deterministic testability. The single request wins because it works with
the current one-way sentinel on ssh2, system SSH, and WSL. A separate
capability probe, two-step negotiation, and a generic cross-transport wire API
are not approved.

The daemon adapter preserves its current sequential connection order. The
control hello is authenticated and answered immediately with daemon identity;
an optional offer is only pending state keyed by that authenticated
`clientId`. The later stream hello proves the socket pair, applies the common
state transition once, and may return the grant in its response. The client
does not mark the daemon connected until that response. An implementation
changes the daemon protocol version as usual, so an exact-version prior daemon
continues independently rather than partially interpreting the optional
fields.

The optional V1 offer is present only when the main rollout gate is on. The
server intersects the offer with its supported versions and clamps
`windowSu`; omission selects bounded legacy delivery while still establishing
the role and generation. When V1 was offered, main accepts only a returned
version it offered and a finite safe integer satisfying
`0 < windowSu <= requestedWindowSu`. An absent or invalid V1 grant closes that
connection attempt rather than silently downgrading it.

“Bounded legacy” is transport backpressure, not a hidden source-credit mode.
It creates no delivery token, source window, or cumulative ACK obligation, and
the relay continues to ignore legacy `pty.ackData`. Slice 3 retains at most
2 MiB of ordinary publications per client and 32 MiB across the relay, with
1 MiB/24 MiB low waters, plus at most one 128 KiB producer-held frame per PTY.
At a cap, `PtyHandler` pauses the PTY; accepted write callbacks/drain remove
transport publications, and crossing both low waters resumes it. Slice 2/4
read pauses propagate through SSH until the relay writer saturates, so stalled
model admission remains bounded without pretending renderer ACKs reached the
relay.

Legacy exit waits only for preceding transport publications and the exit write
callback; main's receive-exit barrier below still waits for its admitted model
and projection work. Transport close cancels the connection's retained
publications and reconnect uses the existing replay/restore behavior. It may
pause all legacy subscribers behind one slow connection until Slice 5a has
authenticated roles, but it neither drops output nor grows without bound.
These mechanics remain enabled when the V1 rollout gate is off.

The session hello creates no PTY token. A later V1 spawn/attach returns a fresh
`deliveryToken` and creates a subscription only for the authenticated
transport client and installed generation. `pty.attach` must receive request
context just as `pty.spawn` does. Spawn failure, identity mismatch, stale
context, and response cancellation create no active V1 subscription. A legacy
spawn/attach returns the current identity/replay shape and creates only the
bounded transport subscription above—no token or source coordinate. During
kill-switch rotation, an old V1 token may be closing while its replacement
legacy transport subscription is opening, but no legacy token exists and no
live token changes mode.

Session ownership is granted by the authenticated session hello, not
constructor-assigned:

- fresh relay deploy writes one endpoint credential beside the versioned
  endpoint, reusing the local daemon's token-authenticated-hello pattern rather
  than inventing a second claim protocol. It has mode `0600` on POSIX or a
  current-user ACL on Windows. `--connect` proves it; a plain dispatcher socket
  without the credential is subscriber-only. Direct stdio uses a launch-bound
  ephemeral credential. The adapter converts proof into
  `allowSessionOwner = true` and does not expose the credential to RPC handlers;
- the main creates one opaque `clientInstanceId` for its relay-session
  lifetime. The first authenticated owner hello when no owner exists binds
  that identity, returns a lease, and starts owner generation 1;
- until that first grant crosses its write fence, a retry with the same
  authenticated identity is idempotent and any competing identity is rejected.
  Once fenced, replacement requires both the current lease and expected
  generation;
- an unexpected owner disconnect retains that lease and its PTY grace cursors
  for 30 seconds. A reconnect presenting the lease and expected owner
  generation atomically increments the generation, rotates the lease, replaces
  the old client, and transfers grace ownership before any new token activates;
- a same-generation retry is idempotent only for the same live client.
  Competing, stale, lease-less, or unauthenticated identities cannot replace
  the owner and may connect only as ordinary subscribers;
- after grace expiry, the old owner lease is invalidated and the next
  owner-authorized session hello can elect a new owner at the daemon's next
  monotonic owner generation; generations are never reused. Ordinary
  subscribers never inherit owner teardown protection merely by arriving first.

Every owner-sensitive PTY response/notification and token carries
`ownerGeneration` or subscriber `clientGeneration`. Main rejects a generation
other than the one installed by its synchronous response hook. The constructor
stdout client is never implicitly a session owner. Production launches
detached on POSIX and Windows, invalidates stdout, and connects the desktop
bridge through `attachClient` over the versioned Unix socket or named pipe.
Direct stdio receives owner authority only from its launch-bound session hello.

Capability support and rollout enablement are separate. Fresh POSIX and
Windows launches receive a safely quoted
`--pty-output-flow-control=v1|off` argument controlling advertisement. A new
main may decline V1 from an already-running detached relay even if it still
advertises it. Disabling the main gate rotates current tokens with the bounded
cancel/reattach procedure below; it never silently changes a live token's
semantics. Sink drain, writer ordering, decoder bounds, and header-ACK
hardening are correctness fixes and are not disabled by this gate.

Production deployment does not form arbitrary mixed-build main/relay pairs.
`computeRemoteRelayDir` content-hash-scopes the install directory and its
socket/named-pipe endpoint, and the `.version` handshake is a second fence, so
the desktop bridge and daemon reached at that endpoint share a build. Reachable
same-build modes are session-granted V1 and main-gated legacy. A missing
mandatory session grant fails readiness. Protocol tolerance for unknown fields
remains for direct/manual relay launches, but an absent session contract is
diagnostic `unsupported-version-skew`, not a rollout cohort.

The reachable upgrade skew is an orphaned prior-version daemon in its old
version directory with live PTYs while the new main connects to a new endpoint.
It retains its old behavior until its own grace/cleanup completes and is not
reachable by the new main's kill switch. Upgrade diagnostics enumerate these
versioned orphan processes; V1 neither adopts their PTYs nor claims to bound
their memory.

Unknown fields are never capability proof. Place the transport-neutral state
types with the narrowest shared session package, while relay/daemon/runtime
wire types remain in their current protocol packages. Do not make the local
provider depend on relay framing for code reuse.

### Data and ACK schema

Flow-controlled output is:

```ts
// relay -> one subscribed client
{
  jsonrpc: '2.0',
  method: 'pty.data',
  params: {
    id: string,
    ptyIncarnation: string,
    data: string,
    deliveryToken: string,
    clientGeneration: number,
    ownerGeneration?: number,
    sourceEndSu: number,
    sourceLengthSu: number,
    seq?: number,
    rawLength?: number, // required and equals sourceLengthSu when transformed
    transformed?: true
  }
}
```

For untransformed frames, `sourceLengthSu = data.length` and `rawLength` is
absent or equal. For `transformed: true`, `rawLength` is required, finite,
safe, non-negative, and equals `sourceLengthSu`; display length is never used
as source credit. A violation cancels the token as malformed. `sourceEndSu` is
the monotonic cumulative coordinate within one opaque `ptyIncarnation`, not a
display offset. A new token starts with `sentEndSu == creditedEndSu` at its
declared checkpoint, so its absolute coordinate still satisfies the window
equation. The source interval is
`[sourceEndSu - sourceLengthSu, sourceEndSu)`. It is independent of `seq`,
which remains the terminal-model source sequence.

ACKs are cumulative and coalescible. Main holds the latest settled end per
token and emits at most one batched notification per SSH session every 8 ms,
or immediately when any token frees at least 64 Ki su:

```ts
{
  jsonrpc: '2.0',
  method: 'pty.ackData',
  params: {
    acknowledgements: Array<{
      id: string,
      deliveryToken: string,
      clientGeneration: number,
      ownerGeneration?: number,
      creditedEndSu: number
    }>
  }
}
```

One frame contains at most 64 latest-value entries; another turn handles the
remainder. Replacing a queued entry for the same token is lossless because the
value is cumulative. ACK frames use the reserved control lane and never one
frame per data frame.

The relay accepts an entry only from the owning dispatcher client and only
when `creditedEndSu` is a finite safe integer satisfying
`previousCreditedEnd <= creditedEndSu <= sentEnd`:

```text
if creditedEndSu > previousCreditedEnd:
  creditedEnd = creditedEndSu
```

Negative, non-finite, unsafe, fractional, over-credit, wrong-client, wrong-PTY,
unknown-token, and stale-token values are rejected and counted diagnostically;
they never clamp into valid credit. Duplicate and regressing values are
no-ops. Token generation, not PTY ID reuse, defines the credit lifetime.

Explicit cancellation is a request so main receives proof:

```ts
// main -> relay
{
  method: 'pty.cancelDelivery',
  params: {
    id: string,
    deliveryToken: string,
    clientGeneration: number,
    ownerGeneration?: number
  }
}
// result
{ canceled: true, sentEndSu: number, creditedEndSu: number }
```

The relay validates client/PTY/token ownership, changes the token to `closing`,
removes its cursor and activation/exit fences, then responds through the control
lane. Duplicate cancellation of the same recently closed token is idempotent.
Main may discard open obligations only after this response drains back through
the mux or the client-generation close proves equivalent cleanup.

Every relay-initiated token close emits this metadata-only control
notification before the token record is forgotten:

```ts
{
  method: 'pty.deliveryCanceled',
  params: {
    id: string,
    deliveryToken: string,
    clientGeneration: number,
    ownerGeneration?: number,
    reason: string,
    sentEndSu: number,
    creditedEndSu: number,
    remainingStartSu: number,
    remainingEndSu: number,
    replacementDeliveryToken?: string
  }
}
```

It covers supersession, activation/exit timeout, reconnect-grace expiry, and
policy cancellation. `remainingStartSu == creditedEndSu` and
`remainingEndSu == sentEndSu` state the exact source interval still unsettled
at the relay. If the sink cannot drain the proof, its generation close is the
proof. Without a replacement, main cancels the matching remaining obligations
and schedules restore/reattach. With a replacement, it keeps those obligations
in `transferring` until the replacement recovery stream proves exact contiguous
coverage, then atomically transfers the covered suffix. Any prefix already
included in the proved model checkpoint is canceled as superseded without
re-ingestion; an uncovered or mismatched remainder cancels with
`restoreRequired` instead of being credited. Every source subrange therefore
settles once. Stale generations are ignored.

### Activation, replay, and idempotent spawn

Token creation and response publication are one fenced operation:

```ts
type ResponseActivation<T> = {
  result: T
  afterResponseDrained: () => void
  cancelBeforeActivation: (reason: string) => void
}
```

The dispatcher places the metadata-only response on the control lane. The
single sink writer invokes `afterResponseDrained` only from the write callback
for that response when it reports success, after all earlier bytes have
drained from the Node writable. An error callback invokes
`cancelBeforeActivation` and closes the client generation. Activation side
effects are queued and never re-enter the scheduler from a synchronous write
callback. A token without recovery then changes
`activating -> active`; a token with recovery changes
`activating -> recovering`. If the sink closes first, the cancel callback
removes the token and its cursor. Enqueue, `write(true)`, and `write(false)`
alone are not activation proof.

The main mux supplies the matching receive fence. Spawn/attach requests
register a synchronous `beforeResolve(result)` hook in their pending-request
record. `handleResponse` validates the returned token and installs it as
`receiving-activation` before resolving the Promise. Notifications for that
known token may then enter only a per-token hold capped by the negotiated
window and charged bytes; they cannot mutate `livePtyIds`, runtime, or
renderer state. Recovery frames are drained into the intake in turns of at
most 32 Ki su, 64 frames, or 4 ms and requeued with `setImmediate`. The token
becomes active only after the matching recovery-complete fence; held live
frames then drain under the same turn budget. Overflow closes the provider as
a protocol failure. This avoids the Promise-microtask race, recovery/live
inversion, and a full-window main-thread turn.

Output produced while a token is activating is retained by its bounded shared
cursor and can pause the native PTY; it is never sent early. Main drops
unknown-token notifications before `livePtyIds.add` or any other side effect
and records a protocol violation. No unknown-token hold is needed because the
wire fence is authoritative.

Before issuing attach or any same-client replacement, main serializes that
`(providerGeneration, ptyIncarnation)` through a migration fence: freeze new
old-token intake, cancel queued-but-unstarted model entries, await the one
in-flight emulator callback, then record the last completed receipt. Every old
callback also checks its captured token/generation before mutating checkpoint
state. If the bounded migration deadline expires or the callback fails, reset
that model generation and request `checkpointUnavailable`; recovery reports
`restoreRequired` instead of replaying a guessed gap.

Attach requests with a proved fence include
`{ ptyIncarnation, previousDeliveryToken, acceptedSourceEndSu }`. A queued,
in-flight, or merely rendered span is not a checkpoint. The response contains
only activation metadata. Without a proved fence, the request carries
`{ ptyIncarnation, checkpointUnavailable: true }` and cannot receive a token.

```ts
type AttachResult =
  | {
      deliveryToken: string
      ptyIncarnation: string
      ownerGeneration: number
      checkpointSourceEndSu: number
      liveStartSourceEndSu: number
      recovery?: {
        streamId: string
        projectionRestore: boolean
        gapStartSu: number
        gapEndSu: number
      }
      supersededDeliveryToken?: string
    }
  | {
      restoreRequired: {
        ptyIncarnation: string
        reason: string
        missingStartSu?: number
        missingEndSu?: number
      }
    }
```

The relay accepts the checkpoint only for the same incarnation and within
`[oldCreditedEndSu, retainedLiveEndSu]`. It never clamps a value forward,
trusts a value beyond sent/retained data, or replays freed pre-credit source;
an invalid or uncovered checkpoint returns the token-free `restoreRequired`
arm. It does not activate a subscription or stream a partial gap; main either
restores an authoritative model generation before retry or surfaces the gap.

The relay streams recovery bodies through a producer-owned recovery lane:
`pty.recoveryData` frames identify `streamId`, token, kind
(`projection-restore` or `gap`), exact source range, and encoded payload.
Projection restore is replacement-only renderer state and is never appended
as new terminal-model input. It may overlap accepted ranges but carries
`replacementOnly: true`. Gap frames cover exactly
`[checkpointSourceEndSu, liveStartSourceEndSu)`, retain their original source
intervals/transform metadata, and are the only recovery frames appended to the
model. If incarnation, checkpoint, or retained coverage cannot prove that
contiguous gap, the metadata reports the missing range and `restoreRequired`
rather than inventing credit or re-appending projection replay.

The new token initializes `sentEndSu = creditedEndSu = gapStartSu`, so gap and
later live frames share one continuous PTY-source coordinate and the normal
window. Gap ACK eligibility requires bounded model admission exactly like live
data. Restore-only snapshot chunks are capped by the existing replay-tail
budget and transport admission but create no upstream source obligation
because their ranges are already at or before the checkpoint.

Only after the last recovery frame's write callback, the relay sends a
metadata-only
`pty.recoveryComplete { streamId, deliveryToken, liveStartSourceEndSu }`
control fence. It is not queued early where control priority could overtake an
unadmitted recovery frame. Its write callback changes `recovering -> active`;
main requires the matching fence and exact contiguous ranges before receive
activation.
Recovery is therefore source-ranged, bounded, and ordered before live data
without charging multi-megabyte JSON to the control queue. Same-build
session-granted legacy uses a transport-scoped metadata marker, producer
admission, and completion fence without a `deliveryToken`; later live output
uses the legacy byte publication caps and drain low waters above.
Notification-style `pty.replay` remains only for unsupported
direct/manual compatibility clients; it is targeted, producer-admitted rather
than control-queued, never broadcast, and returns `restoreRequired` instead of
writing a body that cannot fit current non-reserved capacity.

`pty.serialize` follows the same rule: its response is a bounded stream marker,
snapshot chunks use the producer-owned bulk lane, and a completion fence ends
the stream. No replay-, gap-, or serialize-bearing response embeds its body in
the control lane.

Idempotent agent-session spawn has two layers. The cached
`agentSessionCreateOperationId` promise returns only the physical PTY
identity/outcome. After that promise resolves, every current, non-stale outer
`pty.spawn` request creates its own requesting-client subscription and
activation fence. Creating a token for an existing
`(clientId, clientGeneration, ptyIncarnation)` is one atomic supersession
transaction: create the replacement cursor first, move the old token to
`closing`, cancel its outstanding activation/exit work, emit
`pty.deliveryCanceled(reason='superseded')`, and return the old token in the
new response. The cancellation names the replacement token and exact remaining
old span. Main transfers that span only after matching recovery completes;
otherwise it cancels it and restores. The pair therefore has at most one
active token and no range is both canceled and replayed as new model input. A
retry served from the cache receives one fresh token, never a duplicate live
subscription. If the client becomes stale after physical commit, no token
survives; the next retry can subscribe to the retained PTY.

## Relay output architecture

Split policy from lifecycle and transport:

- `pty-output-span-ledger.ts` owns immutable source spans, token cursors,
  cumulative validation, reconnect-grace ownership, and reclamation.
- `pty-output-scheduler.ts` owns DRR selection, 16 Ki-su publication,
  per-client cursors, recovery, exit barriers, budgets, and additional-
  subscriber eviction.
- `dispatcher-client-writer.ts` owns the one writer per sink, activation
  fences, lane queues, drain callbacks, and close settlement.

`PtyHandler` retains PTY lifecycle, the 8 ms initial/1 ms continuation cadence,
immediate interactive/transformed publication, replay tail, streaming
transform state, and idempotent native `pause()`/`resume()`. It publishes
immutable source spans rather than broadcasting notifications.

### Cumulative span ledger

Each PTY ledger is append-only until every cursor has passed a span:

```ts
type RelaySourceSpan = {
  spanId: number
  sourceStartSu: number
  sourceEndSu: number
  data: string
  splittable: boolean
  retainedBytes: number
}

type PtyDelivery = {
  state: 'activating' | 'recovering' | 'active' | 'sealed-unsettled' | 'closing' | 'closed'
  clientId: number
  clientGeneration: number
  ownerGeneration?: number
  deliveryToken: string
  cursor: { spanId: number; displayOffset: number; sourceOffsetSu: number }
  sentEndSu: number
  creditedEndSu: number
}
```

Different subscribers may stop at different offsets in one span. A cursor
contains both display and source offsets, so no global chunk split can lose or
repeat a suffix. Data storage may coalesce adjacent splittable spans for a
frame or slice one span per cursor; the immutable source boundaries and
cumulative ends do not change. Reclamation requires every live, activating,
sealed-unsettled, closing, or reconnect-grace cursor to pass the complete
span. Native process exit seals admission but does not weaken reclamation.

The transform publisher cuts source input into scalar-safe pieces, never
between a surrogate pair, and records each display result against its source
interval. An untransformed span may be 16 Ki su and is sliced per sink.
A transformed span is indivisible after publication, so its publisher reduces
the source slice until the encoded span is at most 8 KiB, below the token
window, and no larger than the sink's empty non-reserved capacity. An
implementation that cannot stream a transform must pause before the hard limit
and request model restore; it may not over-credit, truncate, or send an
oversized or permanently inadmissible frame.

The existing 100 Ki-su replay-tail policy and the chunked
`RecentPtyOutputBuffer` representation from `79ec57d04` remain. Slice 5c adds a
bounded parallel source-range index or extends that buffer with indexed
records; it must preserve the current append-path performance and equivalence
tests and must not restore the former rolling-string re-slice. Legacy replay
still materializes the same display tail. V1 restore additionally preserves
incarnation, exact source ranges, and transform metadata. Index eviction
follows the buffer's exact retained prefix and never fabricates a mapping.

### Scheduling and fairness

Use deficit round-robin over PTYs, then rotate subscribed clients for the
selected PTY. One scheduling turn admits at most:

- two PTY frames;
- 32 Ki su;
- 2 ms of scheduler work.

Requeue work with `setImmediate` after any limit. Input and control requests can
therefore interleave with output. A recent-input PTY may move to the front once
per round, but repeated interactive classification cannot consume another
PTY's quantum. Preserve the existing bounded interactive fast path: after any
already-queued liveness/control frame, if its token is active, has no earlier
backlog, remaining window covers the exact slice, and the writer admits it
without reserve use, publish one echo frame of at most 4 Ki su immediately
instead of waiting for the 8 ms timer or DRR. Allow at most one such frame per
input epoch; it advances the same cursor once and then yields to normal
priority selection.

For each live/interactive candidate, all gates must be open:

```text
frameSourceLengthSu <= windowSu - (sentEndSu - creditedEndSu)
client writer admits PTY bytes without consuming its control reserve
token state == active
```

For a splittable span, the admitted slice is at most
`min(16 Ki su, remainingWindowSu)`. An indivisible transformed span is admitted
only when its entire source length fits. There is no one-frame window
overshoot. After the writer accepts a frame, advance the cursor and
`sentEndSu` even when the call returns saturated: Node owns that frame exactly
once. Unsent frames remain ledger-owned. Liveness then control, interactive
PTY, recovery/live PTY, and bulk have priority on every writer turn. After any
one producer frame, priority is checked again. A source-bearing gap recovery
uses both capacity and remaining-window gates; a replacement-only projection
restore uses byte admission without changing `sentEndSu`. Both require
`token state == recovering` and are the only PTY producers eligible in that
state.

If an additional subscriber exceeds its retained cursor or outstanding-credit
limit, evict the additional subscriber with the largest retained obligation.
The negotiated session owner is never invalidated because one PTY is slow;
that PTY token pauses instead. There is no 16-connection cap. A separate limit
of 16 simultaneously PTY-subscribing dispatcher clients prevents fan-out
amplification without rejecting non-subscribing remote CLI sockets.

Pause when every remaining delivery is blocked or either retained-byte hard
cap is reached. Resume only when:

```text
perPtyRetainedBytes <= 1 MiB
relayRetainedBytes <= 48 MiB
at least one delivery can advance, or no delivery remains
```

Both predicates are required; the per-PTY low water cannot immediately resume
while the relay-wide budget remains exceeded. Calls are idempotent because a
last `node-pty` callback may re-enter pause/exit handling.

### Exit

On native exit, seal the PTY's output stream after publishing the last ingress
emissions. Create one exit barrier per subscriber and change the delivery to
`sealed-unsettled`:

1. write all preceding data within normal window and drain rules;
2. once that data is accepted by the sink, write `pty.exit` without waiting for
   the final data ACK;
3. record the exit write callback as `exitPublished` only on explicit success;
   on error, generation-close/cancellation proof owns cleanup. Retain the
   delivery, token ledger, cursor, cumulative ACK state, and timeout while any
   `[creditedEndSu, sentEndSu)` suffix remains;
4. close only when the outstanding suffix becomes terminal through cumulative
   ACK application at the relay, exact transfer to a replacement, explicit
   cancellation, or client-generation close proof.

Never force a final tail past the credit window. An additional subscriber that
cannot settle the tail within 30 seconds receives
`pty.deliveryCanceled(reason='exit-timeout')`; its generation close is
equivalent proof if the notification cannot publish. For the session owner,
cancel only this PTY token, keep the bounded sealed record until that proof,
and report restore-required; do not tear down unrelated PTYs. A late valid ACK
against a sealed token remains valid and may complete cleanup. Sealed records
are excluded from the 50-live-native-PTY spawn admission count but remain
charged to retained-data budgets. Relay disposal generation-closes all
barriers and cancels their timers exactly once. Exit listeners and native PTY
disposal run at physical exit; logical delivery cleanup waits for proof.

Main has a matching receive-exit barrier. Receiving `pty.exit` seals the token
against later data but does not immediately call `runtime.onPtyExit`, retire
the headless emulator, clear desktop ranges, close remote subscriptions, or
send renderer exit. It retains every preceding model receipt, projection ID,
remote mapping, and ACK publication record. In order, it:

1. waits for preceding model receipts;
2. publishes or exactly transfers committed desktop ranges and required
   remote mappings;
3. advances/queues the terminal cumulative source ACK;
4. then invokes runtime and renderer exit cleanup while retaining ACK
   publication state until success or generation-close proof.

The barrier has the same charged 30-second deadline. At expiry, main first
sends token-scoped `pty.cancelDelivery` and waits up to 10 seconds for its
proof. That proof permits failing/transferring remote streams, resetting only
this PTY's model generation with `restoreRequired`, and reporting incomplete
exit instead of successful lossless completion. Only if the cancellation
request or proof cannot publish does main close the provider so generation
cleanup proves cancellation; unrelated PTYs are not torn down on the ordinary
timeout path. A late emulator callback cannot mutate the reset generation.
Thus relay sink ordering and main asynchronous model ordering are both proved.

## Dispatcher and transport drain

Every dispatcher client is constructed with one bidirectional transport:

```ts
type SinkWriteResult = 'accepted' | 'saturated' | 'closed'
type SinkWriteSettlement = { ok: true } | { ok: false; error: Error }

type RelayClientTransport = {
  write(data: Buffer, onSettled: (result: SinkWriteSettlement) => void): SinkWriteResult
  writableLength(): number
  writableHighWaterMark(): number
  onDrain(cb: () => void): () => void
  pauseReads(): void
  resumeReads(): void
  close(): void
}
```

Adapters map Node `true` to accepted, `false` to saturated, known-dead to
closed, and map the `stream.write(data, callback)` callback's optional error
to explicit success/failure settlement. Only `{ ok: true }` is a publication
fence. A callback error or thrown error closes the client, cancels the
generation, and cannot activate a token, publish ACK state, or release a source
obligation. A saturated or closed transport is never called again for ordinary
traffic before drain/replacement.
One 13-byte keepalive may bypass a saturated epoch; no second liveness bypass
is allowed until that write callback or drain, so the exemption is constant
space rather than an unbounded queue.

`DispatcherClientWriter` is the only encoder/writer for a client. It owns:

1. a coalesced liveness lane, at most two 13-byte frames;
2. a FIFO control lane, at most 256 frames and 1 MiB encoded;
3. producer-scheduled interactive PTY, recovery/live PTY, and bulk lanes,
   whose frames remain with their producers until the writer admits them.

It reserves
`min(64 KiB, max(1 KiB, floor(highWaterMark / 4)))` below the stream's
high-water mark for liveness/control. PTY, recovery, and bulk admission all
require
`writableLength + frameBytes <= highWaterMark - effectiveReserve`; the
scheduler reduces its source slice and fs/Git producers split chunks before
publish when an encoded frame would not fit. A configured 64 KiB high-water
mark cannot admit the current 256 KiB bulk chunk, so the producer must slice it
below the non-reserved capacity; raising the high-water mark is allowed only
within the encoded-output budget. No producer writes around this gate.
Every transport accepted for a PTY subscription must expose at least 8 KiB of
empty non-reserved capacity. A lower-capacity subscriber is rejected before
token creation, so an already-published indivisible transformed span cannot
become permanently inadmissible.
Liveness is selected first, then control FIFO, interactive PTY, recovery/live
PTY, and bulk; after one producer frame the writer re-runs selection. The
physical stream is still FIFO—V1 does not claim a second SSH channel—but the
finite burst and byte reserve bound head-of-line delay. Control overflow closes
an additional subscriber; overflow on the negotiated session owner is a
transport failure and reconnects that owner generation.

Drain registration is one-shot per saturated epoch. `close`, `error`,
`attachClient`/`detachClient`, owner-generation replacement, and dispose
cancel every outstanding write callback and producer fence exactly once.
`setWrite` remains a test/compatibility seam; production reconnect ownership is
the socket/stdin construction plus `attachClient` and `detachClient`.

In detached relay startup, immediately invalidate the synthetic stdout client
when `stdoutAlive` becomes false. A no-op writer must not look like successful
delivery. The first valid session-owner grant on an `attachClient`
socket/named-pipe client elects the owner; reconnect resume replaces its
generation atomically. Constructor identity and connection order confer no
role.

One `DrainAwareStdoutWriter` owns every byte written to `process.stdout`,
including the initial relay sentinel, handshake residue, dispatcher frames,
and connect-mode forwarding. `runConnectMode` performs
`sentinel -> residue -> socket data` through that writer and pauses the source
socket after stdout saturation; it never mixes ad-hoc `stdout.write()` with
`sock.pipe(stdout)`. The same state contract wraps Unix sockets, Windows named
pipes, and the initial stdio client.

Keepalive frames are independent of PTY credit, use reserved capacity, and have
the single-frame saturated-epoch exemption above. A decoder self-pause or
local writer-saturation epoch suspends dead-link evaluation. Resume calls the
same `rebaseHealthClocks(now)` used after a wake gap: set `lastReceivedAt` and
every existing `unackedTimestamps` entry to `now`, then allow a full timeout
window. Rebasing only received-data age is insufficient because the
outstanding-header-ACK conjunct would remain stale. During a suppressed
interval, keepalive intent coalesces behind one outstanding probe and the
header-ACK timestamp map has a hard entry cap; at 4095 entries it stops
ordinary main-to-relay admission and reserves the final coalesced entry for
cancel/liveness.
No pause fabricates an ACK. Tests sustain both states past 20 seconds and prove
zero reconnect oscillation or timestamp growth.

## Main-process credit ownership

`SshRelaySession.wireUpPtyEvents` remains the provider listener but stops
calling `runtime.onPtyData` and `webContents.send` itself. It validates the
provider generation/token and hands each notification once to a main-only
`SshPtyOutputDelivery` intake installed by `src/main/ipc/pty.ts`. This intake is
the only SSH owner allowed to ingest runtime output, mutate delivery state, or
send `pty:data`.

### Main cumulative ledger

The intake appends immutable wire spans:

```ts
type SshSourceSpan = {
  spanId: string
  providerGeneration: number
  clientGeneration: number
  ownerGeneration?: number
  ptyIncarnation: string
  deliveryToken: string
  sourceStartSu: number
  sourceEndSu: number
  displayStart: number
  displayEnd: number
  displayLength: number
  splittable: boolean
  transform: {
    transformed: boolean
    rawLengthSu: number
    scalarSafe: boolean
  }
  obligations: Map<ConsumerId, SpanObligation>
}

type SpanObligation =
  | { state: 'open' }
  | { state: 'transferring'; to: ConsumerId; reason: string }
  | { state: 'settled'; reason: string }
  | { state: 'transferred'; to: ConsumerId; reason: string }
  | { state: 'canceled'; reason: string }

type TokenAckPublication = {
  obligationsTerminalEndSu: number
  ackQueuedEndSu: number
  ackPublishedEndSu: number
}

type DesktopProjectionSpan = Readonly<{
  spanId: string
  projectionSemanticsId: string
  providerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
  sourceStartSu: number
  sourceEndSu: number
  displayStart: number
  displayEnd: number
  transform: SshSourceSpan['transform']
}>
```

The ledger is separate from `PendingPtyData`. Queue merge, split, remainder,
drop sentinel, query salvage, thinning, and interactive bypass receive no
delivery token and cannot rewrite source spans. At SSH intake, a separate
per-PTY `DesktopProjectionRangeQueue` admits the complete immutable
`DesktopProjectionSpan`; it never receives only `data` plus source length.
`PendingPtyData` continues to store display batching fields plus an opaque
projection admission ID, not mutable source accounting.

`projectionSemanticsId` addresses an immutable per-admission record containing
the accepted chunk's ordered main-authoritative terminal facts and the
projection queue's before/after bounded scanner snapshots. This preserves
current main's dropped-output DEC mode 2031 subscribe/withdraw salvage without
putting mutable scanner state in the source ledger. A source gap resets the
recorded cross-chunk state before later bytes are admitted.

When the data queue sends a display prefix, drops a pending entry, or replaces
it with salvage, it asks the range queue to consume the same operation. The
range queue—not mutable `rawLength` fields—returns the exact source length and
transform metadata for the renderer payload and consumer obligation.
Admission is transactional:

1. reserve model bytes and create the source span;
2. stage the main terminal facts and before/after projection scanner snapshots;
3. reserve the exact desktop range by `spanId` and `projectionSemanticsId`;
4. enqueue display data and publish only after every reservation succeeds;
5. commit model ownership, main facts, and projection admission together.

If model reservation fails, remove every uncommitted reservation. If
projection admission or `webContents.send` fails, roll back the uncommitted
range selection and restores the prior projection scanner snapshot without
publishing staged facts. After model commit, main facts remain published once
and a send failure atomically transfers the desktop obligation plus committed
projection state to a model-restore marker. Queue merge/split preserves the
ordered admission IDs, salvage/drop transfers exact superseded ranges and DEC
mode 2031 decisions, renderer reload transfers committed desktop obligations
before clearing, and token replacement rejects stale IDs by generation while
exact replacement coverage transfers their ranges. Untransformed source may
split only at a recorded display/source offset; a transformed range stays
indivisible. No rollback fabricates an ACK or destroys a live relay
obligation. Renderer ACK retirement reserves both range and ledger mutations,
validates both, then performs one no-throw commit; neither side becomes
terminal before that commit.

Development assertions enforce:

```text
receivedSu = openSu + transferringSu + settledSu + transferredSu + canceledSu
obligationsTerminalEndSu =
  largest contiguous end whose required obligations are terminal
ackPublishedEndSu <= ackQueuedEndSu <= obligationsTerminalEndSu
```

Only `SshPtyOutputDelivery` may call the V1 cumulative ACK coalescer. The
generic `IPtyProvider.acknowledgeDataEvent(id, delta)` API remains for local
and daemon behavior. Legacy SSH may still emit its current delta during
migration, but the relay ignores it and no legacy bound depends on it; it is a
hard no-op for negotiated V1 PTYs. At every shared `pty:ackData`, resync, heal,
write-off, drop, salvage, and reload call site, V1 routes renderer display
progress through
`DesktopProjectionRangeQueue`: parsing settles exact mapped source ranges and
heal/write-off atomically transfers them. These projection transitions may
advance ledger eligibility already earned by the model, but never emit legacy
`{ id, charCount }` wire traffic or manufacture source progress from a display
count.

ACK eligibility and ACK publication are separate transitions. Terminal
obligations advance `obligationsTerminalEndSu` without waiting for a write
callback. The coalescer independently queues the latest cumulative eligible
end and advances `ackQueuedEndSu`. The mux write callback advances
`ackPublishedEndSu` and permits cleanup only on explicit success; it never
creates eligibility. A synchronous throw, callback error, or close leaves the
cumulative value queued for a generation-aware retry or reaches cancellation
proof on provider close. Coalescing replaces only with a greater cumulative
value, so retries cannot lose an eligible prefix.

### Bounded asynchronous model admission

Replace the unmetered headless-emulator `writeChain` contract with a charged
FIFO per PTY and global scheduler. `acceptPtyData` returns a Promise receipt:

1. before capturing the frame, reserve its charged retained bytes against the
   per-PTY and global model-admission budgets;
2. the per-PTY budget covers one full token window and the global budget
   matches the relay retained-data cap, so a conforming owner reaches token
   backpressure before routine admission denial. If a transient frame still
   cannot fit, keep that current decoded frame in a separately charged intake
   slot and leave its model obligation open. Enter selective pressure mode:
   quarantine at most 1 MiB or 64 later PTY data frames in wire order while
   continuing to apply transport liveness, unrelated RPC control, and
   cancellation proofs. Keep `pty.exit`, `pty.recoveryComplete`, activation
   fences, and other source-ordering lifecycle frames behind all preceding
   quarantined data for their token. A same-token cancellation proof may bypass
   only by atomically canceling those quarantined obligations first. Do not
   admit quarantined data out of order. If the reserve fills before capacity
   returns, pause reads and start a 10-second provider-close deadline;
3. enqueue only after capacity is owned. Snapshot all consumer memberships and
   allow bounded desktop/remote fan-out at that point; neither projection
   progress nor queue ownership settles the required model obligation.
   Preserve per-PTY order while allowing fair turns across PTYs;
4. resolve the receipt only from the emulator write callback. Then release the
   queue charge, settle the model obligation, and advance eligible credit;
5. resume admission only after both low waters hold. Rejection cancels the
   token and schedules restore; it never passes through the current
   best-effort swallowed-error path.

The relay writer rechecks control priority after every PTY frame, so the
receive reserve needs to cross only a bounded already-written PTY burst, not an
unbounded producer stream. If no control can be reached within the reserve and
deadline, provider close supplies generation cleanup proof. Selective pressure
never settles, drops, or reorders a data frame and never lets a model stall
silence cancellation indefinitely.

Provider close, token supersession, PTY exit, and runtime disposal cancel
queued-but-unstarted entries and reject their receipts exactly once. An
in-flight emulator callback owns its entry until completion or failure and
must pass its captured token/generation check before committing. Reconnect and
supersession use the migration fence above rather than letting that callback
race a replacement checkpoint. The old Promise chain may remain as the
per-PTY execution primitive only after each link is charged by this scheduler;
it is no longer an unbounded owner.

### Desktop, mobile, web, and agent policy

Consumer membership is snapshotted when each span arrives:

- The main terminal model is always required.
  `runtime.acceptPtyDataBounded` returns the asynchronous receipt Promise
  above; it resolves only after the emulator accepts the span.
  Status and agent-session observers derived from that model add no duplicate
  obligation.
- The desktop renderer is a recoverable projection. Parsing settles its
  obligation. Hidden thinning, reload, destroyed-window, send failure,
  pending-cap replacement, or delivery heal atomically transfers the
  obligation to the already-accepted main model and emits a model-restore
  marker before settlement. A transfer requested before the model receipt
  remains pending and commits only when that receipt succeeds. Once the model
  receipt exists, desktop obligations
  remain tracked for main-to-renderer bounds but are not required for upstream
  ACK eligibility.
- A mobile/web/raw agent terminal subscriber that negotiated lossless ACKs is
  required while attached and settles independently from its bounded delivery
  cursor. At its ACK cap it stops sending and remains required; a stall cannot
  auto-transfer itself out of upstream backpressure. On explicit detach or
  replacement, transfer to a snapshot/resubscribe marker if supported;
  otherwise cancel that consumer and close only its stream.
- A legacy or observational remote subscriber is best-effort and creates no
  upstream obligation. It receives bounded fan-out and is dropped/resynced on
  overflow.

Current mobile notification replay remains a separate runtime method and
identity space. Its notification epoch and post-local-delivery watermark prove
notification catch-up only; terminal obligations require the stream generation
and immutable encoded-byte/source-range mapping below.

The token ACK advances when the main model and every currently required
lossless consumer for the contiguous prefix have terminal obligations. A
desktop stall therefore cannot freeze a healthy mobile/web consumer, while an
actually lossless remote subscriber still participates explicitly.

Each lossless remote stream owns an immutable encoded-byte/source-range ledger:

```ts
type LosslessRemoteSendRange = {
  streamGeneration: string
  encodedStartByte: number
  encodedEndByte: number
  providerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
  sourceRanges: ReadonlyArray<{
    spanId: string
    sourceStartSu: number
    sourceEndSu: number
    indivisible: boolean
  }>
}
```

Existing `terminal.multiplex` `ackOutput: 1` remains a byte-delta flow-control
mechanism and creates no SSH source obligation. A required source-mapped stream
must separately negotiate `ackOutputSourceRanges: 1`. The server allocates an
opaque `streamGeneration` in the subscribed control frame; every cumulative
ACK carries that generation and `ackedEndByte`. A reused `streamId`, old
client, legacy `{bytes}` ACK, or stale generation cannot settle the new stream.

The mapping is recorded only when the remote writer accepts that exact encoded
output payload, in the same byte unit used by its ACK window. Batching flushes
on provider generation, PTY incarnation, or delivery-token change. When one
encoded frame contains multiple same-identity source spans, it records their
ordered composite list rather than collapsing them into a proportional range.
An ACK must be a finite safe integer in
`previousAckedEndByte <= ackedEndByte <= lastAcceptedByte`; excessive values
are rejected and counted, never clamped into full settlement. An in-range
partial-frame ACK is recorded but settles no source units; only complete
recorded frame boundaries settle their exact ordered source ranges. UTF-8
width, JSON escaping, `rawLength`, and display transforms are never converted
proportionally.
Before stream replacement, snapshot recovery, or detach, create the
replacement owner and atomically transfer every remaining mapping; otherwise
cancel that consumer and its bounded stream. Old stream generations cannot
settle new mappings.

The stall policy is deliberately split. Desktop-only parse failure reaches its
bounded projection cap, transfers to model restore, and lets upstream credit
continue. A stalled model receipt or attached lossless remote has no automatic
projection transfer: its required obligation stays open, the token window
exhausts, and the relay pauses the native PTY when every remaining delivery is
blocked. Only an explicit, capability-proven snapshot/resubscribe transition
can transfer a lossless remote obligation.

### Exactly-once lifecycle

`settle`, `beginTransfer`, and `cancel` are compare-and-set operations from
`open` for both the upstream token span and each consumer obligation.
`transferring` becomes `transferred` only after the named replacement fence or
becomes `canceled` on mismatch/failure; duplicates are no-ops with diagnostics.
Required obligations becoming terminal advances
`obligationsTerminalEndSu`. That transition makes the cumulative ACK eligible;
it does not wait for ACK publication. The coalescer advances `ackQueuedEndSu`,
and only the later mux write callback advances `ackPublishedEndSu` and allows
record reclamation. A token span begins transfer only when the relay atomically
moves reconnect-grace ownership to a new token and the attach response
declares the new cumulative boundary, or cancels after
explicit/connection-close proof. The transaction creates the replacement
owner before marking source `transferring`; only exact recovery-complete
coverage terminally transfers it.

| Event                                                 | Mandatory transition                                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| model accepts; desktop/mobile parses                  | settle that consumer                                                                                                                           |
| hidden thinning, empty transform, pending-cap salvage | preserve ordered terminal facts/scanner state, then transfer desktop to model and emit restore marker                                          |
| renderer reload/destroy/send failure/heal             | transfer all desktop obligations to model before clearing queue/accounting                                                                     |
| pane closes while provider/token remains live         | transfer recoverable views, then request token cancel if no required consumer remains                                                          |
| PTY exit                                              | relay seals token; main retains prior receipts/projections/remotes; runtime/renderer exit only after terminality or bounded cancellation proof |
| provider replacement/reconnect                        | close old client generation; transfer only exact ranges proven by replacement recovery, otherwise cancel and restore                           |
| relay `pty.deliveryCanceled`                          | without replacement, cancel matching remainder and restore; with replacement, enter `transferring` pending coverage                            |
| same-client token supersession                        | create replacement first, transfer exact covered remainder after recovery, cancel any uncovered range                                          |
| explicit live-token reset/kill switch                 | `pty.cancelDelivery` response proves relay cancellation before local discard; failure closes the provider transport                            |
| relay/client dispose                                  | relay cancels token/cursors; main cancels only after close-generation proof                                                                    |

There is no “abandon live token” transition. A main-side path that cannot prove
settlement, transfer, or relay cancellation must keep the ledger or close the
provider. Delayed renderer/mobile ACKs carry the consumer generation and cannot
settle a new provider generation or reused PTY ID.

### State-machine pseudocode

```text
session owner:
  none --authenticated claim--> electing(next monotonic generation)
  electing --session-grant write success--> active
  electing --session-grant write error--> none(close generation)
  electing --client close/cancel--> none
  active --proved live replacement/tokens to grace-->
    active(generation + 1, rotated lease)
  active --unexpected client close--> grace
  grace --proved resume--> active(generation + 1, rotated lease)
  grace --30-second expiry--> none(invalidate lease, cancel grace cursors)

relay token:
  create -> activating
  activating --response write success/no recovery--> active
  activating --response write success/recovery--> recovering
  activating --response write error--> closed(cancel generation)
  recovering --recovery-complete write success--> active
  activating --stale/close--> closed(cancel)
  activating|recovering|active --same-client replacement--> closing(superseded)
  active --native exit--> sealed-unsettled
  sealed-unsettled --exit write success--> sealed-unsettled(exit-published)
  sealed-unsettled --exit write error--> closing(generation proof)
  sealed-unsettled --relay applies suffix ACK/exact transfer--> closed
  sealed-unsettled --timeout--> closing(exit-timeout cancellation proof)
  active --cancel request--> closing
  closing --cancel response/client close proof--> closed

writer:
  writable --write(false)--> saturated --drain--> writable
  writable|saturated --close/error/detach--> closed

main obligation:
  open --consumer receipt--> settled
  open --replacement created atomically--> transferring
  transferring --exact replacement coverage fence--> transferred
  transferring --missing coverage/replacement close--> canceled
  open --relay cancel/close proof--> canceled

main token span:
  open --required consumers terminal--> obligations-terminal
  obligations-terminal --coalescer queues cumulative end--> ack-queued
  ack-queued --ACK write success--> ack-published(cleanup eligible)
  ack-queued --ACK write error--> ack-queued(close/retry)
  open|obligations-terminal|ack-queued
    --attach boundary + replacement created--> transferring
  transferring --exact recovery-complete fence--> transferred
  transferring --gap/replacement failure--> canceled
  open|obligations-terminal|ack-queued
    --cancel response/client-generation close--> canceled

main receive token:
  unseen --beforeResolve--> receiving-activation
  receiving-activation --validated response/no recovery--> active
  receiving-activation --source-ranged recovery + complete fence--> active
  active --pty.exit--> exit-sealed
  exit-sealed --prior model/projection/remote terminal--> exit-ack-queued
  exit-ack-queued --runtime + renderer exit cleanup--> exited-awaiting-ack-publication
  exited-awaiting-ack-publication --ACK success/generation close--> closed
  exit-sealed --deadline--> canceling-exited-token
  canceling-exited-token --token cancellation proof--> closed(restore-required)
  canceling-exited-token --proof cannot publish--> closing-provider
  receiving-activation|active --overflow/cancel/close--> closed
```

```ts
function reserveSshAdmissionAtomically(
  token: DeliveryToken,
  frame: TokenizedPtyData
): SshAdmissionReservation {
  const model = runtime.reservePtyData(frame)
  let span
  let projection
  try {
    span = token.ledger.reserveContiguous(frame, model)
    span.require('model')
    addConsumerObligationsFromCurrentPolicy(span)
    projection = desktopQueue.reserve(toDesktopProjectionSpan(span))
    return { model, span, projection }
  } catch (error) {
    desktopQueue.rollbackIfReserved(projection)
    token.ledger.rollbackIfUncommitted(span)
    runtime.rollbackPtyData(model)
    throw error
  }
}

function acceptSshFrame(frame: TokenizedPtyData): void {
  const token = validateActiveProviderToken(frame)
  let reservation
  try {
    reservation = reserveSshAdmissionAtomically(token, frame)
  } catch (error) {
    cancelTokenAfterAdmissionFailure(token, error)
    return
  }
  const { span, modelReceipt, projectionSpan } = commitSshAdmission(reservation)
  try {
    desktopQueue.publish(projectionSpan, frame.data)
  } catch (error) {
    transferDesktopToModelRestore(span, 'renderer-send-failed', error)
  }
  fanOutToCurrentRemoteConsumers(span)
  void modelReceipt.then(
    (receipt) => {
      span.settle('model', receipt)
      commitPendingProjectionTransfers(span)
      advanceObligationsTerminalEnd(token)
      queueCumulativeAck(token)
    },
    (error) => cancelTokenAfterModelFailure(token, span, error)
  )
}

function retireDesktopDisplayPrefix(id: string, processedDisplayChars: number): void {
  const selection = desktopRangeQueue.reserveDisplayPrefix(id, processedDisplayChars)
  const transaction = ledger.reserveDesktopSettlement(selection.ranges)
  try {
    validateDesktopSettlement(selection, transaction)
    commitDesktopRangeAndLedgerAtomically(selection, transaction, 'renderer-parse')
  } catch (error) {
    ledger.rollbackDesktopSettlement(transaction)
    desktopRangeQueue.rollback(selection)
    throw error
  }
  advanceObligationsTerminalEndForPty(id)
  queueCumulativeAckForPty(id)
}

function replaceDesktopProjection(id: string, reason: string): void {
  for (const obligation of ledger.openDesktopObligations(id)) {
    obligation.beginTransferTo('model-snapshot', reason)
  }
  scheduleModelRestoreAfterReceipts(id, reason)
  commitTransfersWhoseModelReceiptsExist(id)
  advanceObligationsTerminalEndForPty(id) // pending transfers remain ineligible
  queueCumulativeAckForPty(id)
}

function onAckWriteSettled(token: DeliveryToken, endSu: number, result: SinkWriteSettlement): void {
  if (!result.ok) {
    closeProviderAfterAckWriteError(token, result.error)
    return
  }
  token.ackPublishedEndSu = Math.max(token.ackPublishedEndSu, endSu)
  reclaimPublishedPrefix(token)
  maybeCloseSealedDelivery(token)
}
```

Token/span validation, charged admission, and every membership obligation occur
before asynchronous model execution. Desktop/remote fan-out may begin after
the admission budget owns the frame, but the model obligation settles only
after the emulator callback. Admission wait leaves it open and pauses reads at
the charged limit; rejection triggers token cancel rather than acknowledging
data the model did not own. Renderer progress is always display-side input to
the range queue and is never interpreted directly as source units.

## Incremental frame decoding

Extend the actual main transport contract:

```ts
type MultiplexerTransport = {
  write(data: Buffer, onSettled: (result: SinkWriteSettlement) => void): SinkWriteResult
  writableLength(): number
  writableHighWaterMark(): number
  onWriteDrain(cb: () => void): () => void
  onData(cb: (data: Buffer) => void): () => void
  onClose(cb: () => void): () => void
  pauseReads(): void
  resumeReads(): void
  close(): void
}
```

`waitForSentinel` constructs these hooks from the real `ClientChannel`:
`channel.stdin.write(buf, callback)`, writable length/high-water mark, and
`on('drain')` for output, plus
`channel.pause()/resume()` for relay stdout. This covers ssh2 and
`SystemSshCommandChannel`, whose stdout-facing channel implements the same
Readable contract. WSL child stdin/stdout exposes the same metrics,
callback/drain, and pause/resume adapter. The startup residue is delivered once
before later data.

`SshChannelMultiplexer` also owns one main-to-relay writer. Its lanes are
liveness, interactive/control (requests, PTY input, cancellation, coalesced
PTY ACK), and producer-owned bulk. It applies the same effective reserve and
applies the same one-keepalive saturated-epoch exemption; all ordinary writes
wait for their per-write callback and `onWriteDrain` after saturation. Bulk
chunks are sliced to the non-reserved capacity and priority is rechecked
between chunks. Thus an ACK burst or file/Git stream cannot build an invisible
queue ahead of keystrokes, and V1 ACK settlement has a concrete write fence.

On the relay, the initial client uses `process.stdin.pause()/resume()` and each
accepted Unix-socket/named-pipe client uses `socket.pause()/resume()`.
`attachClient` accepts those hooks; `detachClient` releases them. Handshake
decoders retain synchronous first-frame behavior and transfer both exact
residue and pause ownership to the dispatcher.

Both protocol copies then use this state machine:

1. `feed()` appends buffer views without copying and charges bytes.
2. Drain at most 64 frames or 4 ms.
3. If another complete frame remains, acquire one idempotent decoder pause
   epoch and continue with `setImmediate`.
4. Release the pause only when complete-frame backlog and queued bytes fall
   below low water.
5. `reset`, handshake `drain`, transport close, and dispose cancel the
   continuation and release exactly the epoch they own.

Main model-pressure mode is the one bounded exception to immediate read pause.
It may classify complete frames into the charged 1 MiB/64-frame data
quarantine while dispatching only eligible control/liveness frames, then
either drains data and token-ordering fences in original order or closes the
provider at the deadline. Exit, recovery completion, and activation cannot
overtake a preceding quarantined frame for the same token. It does not scan
past an incomplete or oversized frame and cannot expand the ordinary decoder
input cap.

Handshake consumers require the first complete frame synchronously. Preserve
that behavior, then yield before later frames. `drain()` must cancel a scheduled
continuation and return all unread handshake residue in exact byte order so the
next consumer receives it once.

The decoder permits one advertised valid 16 MiB frame plus 1 MiB input slack.
A partial valid frame keeps reads enabled until that cap; exceeding it closes
the offending transport rather than retaining back-to-back maximum frames.
Oversized payloads are discarded incrementally without full retention.
Sender-side finite PTY bursts and the reserved control lane bound how far a
keepalive/control frame can sit behind PTY data. While paused by this decoder,
the mux suspends both dead-link conjuncts. Resume rebases `lastReceivedAt` and
all outstanding header-ACK timestamps exactly like the existing wake-gap
handler; outgoing keepalives still run.

In `SshChannelMultiplexer.handleFrame`, clamp header `ack` to
`nextOutgoingSeq - 1` and delete only keys already present in
`unackedTimestamps`. Never iterate a dense integer range toward an untrusted
32-bit value. This remains independent from PTY credit.

## Cleanup and reconnect

Every dispatcher client has a generation, and the negotiated session owner has
a separate transferable owner generation. Socket close/error,
`attachClient`/`detachClient`, and dispose invalidate or advance the client
generation atomically. Unexpected disconnect retains the owner generation and
lease through grace; only a proved replacement increments it, and grace expiry
invalidates the lease so a later election starts a new generation. Each
transition:

- cancel read-pause epochs, writer callbacks, and scheduled work;
- reject queued control frames;
- move active PTY cursors to reconnect grace or cancel them;
- preserve sealed-unsettled suffixes until the relay applies their ACK, exact
  transfer, or cancellation/generation-close proof;
- retry or cancel queued cumulative ACK state without collapsing
  `obligationsTerminalEndSu`, `ackQueuedEndSu`, and `ackPublishedEndSu`;
- roll back uncommitted desktop reservations and transfer committed
  projection IDs before clearing renderer queues;
- cancel uncommitted terminal-fact publications, restore their prior scanner
  snapshots, and transfer committed projection scanner state exactly once;
- release shared spans no longer referenced;
- recompute native PTY pause state;
- expire pending RPC ownership.

Unexpected loss of the session-owner generation with active PTY tokens creates
one `reconnect-grace` cursor per PTY for 30 seconds. It retains at most
512 Ki su and 2 MiB charged bytes per PTY; reaching either cap pauses that PTY
instead of dropping more output. A valid owner resume atomically installs the
new owner generation, transfers each cursor to a new token, and returns only
metadata for its bounded recovery stream. Source-ranged gap and
projection-restore frames then drain through the recovery lane before the
completion fence and live activation. Expiry invalidates the owner lease,
emits `pty.deliveryCanceled` when possible, releases the gap, resumes the PTY,
and records restore-required/data-gap telemetry. Ordinary subscriber loss or
no-subscriber state outside owner grace retains only the existing replay tail.

`SshRelaySession.reattachKnownPtys` waits for session-grant readiness and each
PTY's model-migration fence, then runs at most eight attaches concurrently.
Each PTY has its own 10-second attempt deadline and `try/catch`; one failure
cannot abort later PTYs. `notFound` and identity mismatch keep their existing
stale-lease behavior. Other errors are recorded, retried once with bounded
jitter while the same reconnect attempt is current, then surfaced per PTY
without tearing down successful siblings. Time-to-last-reattach is therefore
bounded by waves rather than `N × RTT`.

Reconnect and replay always create new tokens even when IDs are reused. Old
ACKs and callbacks fail generation/token checks. The attach response declares
the checkpoint, exact gap range, restore-only snapshot, and live boundary, so
main never double-ingests old obligations. Replace
`SshRelaySession.forwardReattachReplay` with this tokenized intake and delete
`RECONNECT_REPLAY_DUPLICATE_WINDOW_MS`/`shouldForwardReattachReplay`: a
wall-clock fingerprint can suppress legitimate identical output, while the
source checkpoint is authoritative. Exit before reattach may still synthesize
`code: -1` after `notFound`; retaining remote exit tombstones is a separate
behavior change and is not required for the memory bound.

For an operation-ID spawn replay, physical result lookup completes first; the
current request then creates and fences a new subscription as specified above.
Disconnect after physical commit/before response leaves the PTY retained but
no stale token.

PTY shutdown and natural exit cancel native pause state before disposing
node-pty. Natural exit may still leave a charged sealed-unsettled delivery
record; only its native process is gone. Relay disposal generation-closes those
records and clears scheduler/exit timers before walking PTYs. A folder
workspace removal follows the same PTY teardown path; no design step assumes a
Git worktree.

### SSH producer-pause intent

Negotiated V1 implements `SshPtyProvider.pauseProducer` and `resumeProducer`
with a token/generation-scoped `pty.setDeliveryPaused` request; window size is
not renegotiated to zero. Relay marks that owner delivery ineligible and pauses
the native PTY only when all required deliveries are ineligible, while another
healthy subscriber may continue. Resume restores eligibility under the
original window. `setPtyBackgrounded` is a separate token-scoped scheduling
hint; it does not itself drop source data or silently convert a lossless model
obligation into keep-tail behavior.

For V1, desktop pending-cap pressure transfers the recoverable projection and
does not call producer pause. Model-admission or required-lossless pressure and
explicit background policy may call it. Local, daemon, and legacy provider
behavior remains unchanged. Update the provider-interface and IPC comments
that currently assume SSH has an independently bounded pending queue.

## Budgets

Every limit has one unit. Source-flow limits use `su`; heap/transport limits use
bytes measured at the point that owns the memory.

| Resource                        |                                  High limit |           Low/flush point | Action                                      |
| ------------------------------- | ------------------------------------------: | ------------------------: | ------------------------------------------- |
| Legacy publications per client  |                                       2 MiB |                     1 MiB | pause affected PTYs; release on drain       |
| Legacy publications per relay   |                                      32 MiB |                    24 MiB | pause affected PTYs                         |
| Legacy producer-held PTY frame  |                                     128 KiB |            next admission | hold one; pause before another              |
| V1 data frame                   |                             16 Ki su target |                         — | scalar-safe slice/coalesce                  |
| Encoded PTY frame               |                                     128 KiB |                         — | reduce source slice before publish          |
| Token outstanding credit        |                                   256 Ki su |      64 Ki su newly freed | stop send / eager ACK                       |
| Sealed-unsettled suffix         |     token window; 30 s timer per subscriber | ACK/transfer/cancel proof | retain ledger; cancel stalled token         |
| Recovery data                   | min(128 KiB, current non-reserved capacity) |                 next turn | recovery lane before live                   |
| Reconnect-grace source          |                           512 Ki su per PTY |                         — | pause at cap                                |
| Retained live data per PTY      |                                       2 MiB |                     1 MiB | evict subscriber, then pause                |
| Retained live data per relay    |                                      64 MiB |                    48 MiB | evict largest subscriber, then pause        |
| Replay tail                     |                existing 100 Ki su × 50 PTYs |                         — | source-range trim; bytes charged globally   |
| PTY-subscribing clients         |                                          16 |                         — | reject subscription, not socket             |
| Liveness/control writer reserve |         25% of high water, capped at 64 KiB |                     drain | producer lanes cannot consume               |
| Minimum PTY sink capacity       |                    8 KiB non-reserved empty |                         — | reject PTY subscription                     |
| Metadata control response       |                                      64 KiB |                         — | body must use producer stream               |
| Control queue                   |                          256 frames / 1 MiB |                     drain | close subscriber; owner reconnect           |
| Bulk producer frame             |          current non-reserved sink capacity |                next frame | slice, admit, recheck priority              |
| Decoder                         |                  16 MiB frame + 1 MiB slack |       no complete backlog | pause/close at hard cap                     |
| Decoder turn                    |                           64 frames or 4 ms |                 next turn | `setImmediate`                              |
| Header-ACK timestamp entries    |                           4095 + 1 reserved |                ACK/resume | stop ordinary writes; coalesce liveness     |
| Main receive-activation hold    |   256 Ki su / 2 MiB per token; 64 MiB total |        recovery completes | pause aggregate; close provider on cap      |
| Main model admission per PTY    |                           256 Ki su / 2 MiB |         128 Ki su / 1 MiB | pause mux admission                         |
| Main model admission global     |                         12.5 Mi su / 64 MiB |          8 Mi su / 48 MiB | pause mux admission                         |
| Main blocked-intake slot        |                           one 128 KiB frame |           model low water | hold blocked frame                          |
| Main pressure control reserve   |                           1 MiB / 64 frames |  10-second close deadline | quarantine data; service control            |
| Main model migration fence      |                                  10 seconds |                         — | reset generation / restore required         |
| Main desktop in-flight          |  existing 512 Ki su per PTY / 8 Mi su total |             existing lows | transfer/restore policy                     |
| Lossless remote send ledger     |                 2 MiB/stream, 16 MiB global |        1 MiB/12 MiB bytes | stop send; explicit detach transfers/closes |
| Activation/exit/owner grace     |                                  30 seconds |                         — | token cancel/gap policy                     |

Retained strings are charged once as
`max(Buffer.byteLength(value, 'utf8'), 2 * value.length) + 128`; encoded buffers
use exact `Buffer.byteLength`; ledger/cursor entries charge 128 bytes. Shared
strings are not multiplied by subscriber count, but each cursor is charged.
Sent-but-uncredited source units are not described as retained memory.

The table is arithmetically reachable:

- 256 Ki ASCII su charges at most about 512 KiB plus records.
- 256 Ki BMP/CJK su at three UTF-8 bytes each charges about 768 KiB.
- 256 Ki su of surrogate-pair characters has 128 Ki scalar values and about
  512 KiB UTF-8/UTF-16 storage.
- A 512 Ki-su ordinary reconnect backlog is at most about 1.5 MiB for valid JS
  strings; 32 16-Ki-su span records keep it below the 2 MiB per-PTY cap.
  Highly fragmented transformed records bind the charged 2 MiB cap earlier.
  Recovery is streamed and never compared with the 1 MiB control queue.
- JSON control-character escaping can reach six encoded bytes per su, so a
  16 Ki-su frame is below 96 KiB plus envelope and the separate 128 KiB cap.
- A transformed span with `rawLength !== data.length` consumes source credit
  by `rawLength` and heap/wire budgets by its actual retained/encoded bytes;
  neither value is converted into the other.
- Fifty PTYs cannot each reach 2 MiB because the 64 MiB relay cap binds first;
  the independent 48 MiB global low water prevents immediate resume thrash.
- Model admission charges captured strings and queue records before a Promise
  link owns them. Its 64 MiB global high water matches the relay retained-data
  cap and its 12.5 Mi-su high equals 50 token windows, while each
  256 Ki-su/2 MiB per-PTY high covers one full token window; the separate
  128 KiB blocked slot covers the decoder frame that triggered pause without
  hiding it in the model budget.
- Encoded lossless-remote bytes remain charged until full frame-boundary ACK or
  atomic transfer; the ledger's source units are never estimated from bytes.

One re-entrant native callback after `pause()` is a charged transient overshoot.
The callback may cross a retained-memory high cap by at most one charged native
chunk, but it is never admitted past token credit: splittable source is trimmed
to remaining window and an indivisible transform waits. If retained memory
crosses a hard cap, stop publication, mark restore-required, and retain only
the already-owned bounded state. Module constants allow test overrides; Linux
Docker heap/RSS plateaus validate allocator slack before release.

## Telemetry

Expose aggregate counters in existing relay/main diagnostic snapshots without
logging terminal contents or raw PTY IDs:

- active/activating/recovering/closing tokens, owner generation/election/resume
  outcomes, and PTY-subscribing clients;
- paused and reconnect-grace PTYs, grace bytes, recovery lane/fence latency,
  exact gap ranges, restore-only snapshots, expiries, and gap outcomes;
- client writer state, lane depths, reserved-byte denials, and activation-fence
  latency/cancellation, split bulk bytes, and per-priority wait;
- current/peak retained bytes and outstanding su by redacted client/PTY;
- pause count and total paused milliseconds;
- sink saturation count and duration by stdout/socket;
- slow-client detach and control-overflow counts;
- ACK accepted, duplicate, regression, over-credit, malformed, and stale-token
  counts, plus ACK frames/second, entries/frame, and encoded bytes/second;
- span obligations opened, transferring, settled, transferred, canceled,
  duplicate-terminal, and oldest-open/oldest-transferring age by consumer
  class;
- per-token obligations-terminal, ACK-queued, and ACK-published ends plus their
  deltas; sealed-unsettled count, suffix size/age, exit-published state, and
  timeout cancellation proof;
- desktop projection reservations, commits, rollbacks, model transfers, stale
  identity rejects, and outstanding source/display ranges;
- model-admission current/peak bytes per PTY/global, blocked duration,
  emulator completion/failure/cancellation, migration-fence latency/timeout,
  late-generation rejects, and low-water resumes;
- lossless-remote encoded bytes, partial/frame-boundary ACKs, mapped source
  ranges, generation rejects, and transfer/cancel outcomes;
- decoder queued bytes, yielded turns, maximum frames/turn, and maximum
  callback duration, read-pause duration, liveness-timeout suppression,
  header-ACK timestamp depth/cap denials, and keepalive coalescing;
- exit-barrier timeout count;
- reconnect attach wave latency, per-PTY retry/failure, token supersession,
  relay-initiated cancellation proof, and time-to-last-success;
- same-build negotiated and disabled-by-main sessions, unsupported manual
  version skew, and discovered orphan prior-version daemons, keyed by relay
  build/version rather than legacy ACK traffic.

Rate-limit warnings by connection and reason. Log thresholds and state
transitions, never data. Add an E2E-only snapshot request so tests can assert
plateaus, obligation conservation, pause/resume, and zero false reconnects
without parsing logs.

## Incremental implementation map

Do not implement this design as one architectural rewrite. Each slice below is
independently reviewable, keeps legacy framing valid, and must land with its
own deterministic oracle. Later slices may revise file placement, but not the
semantic boundaries or invariants.

### Slice 1: hostile-header and accounting hardening

- In `src/main/ssh/ssh-channel-multiplexer.ts`, clamp header ACKs and delete
  only present timestamp keys; cap retained timestamps.
- Add focused unit tests for `ack=0xffffffff`, concurrent ACK/timeout cleanup,
  and liveness rebasing.
- No relay, daemon, runtime, or provider protocol change.

### Slice 2: bounded decoder turns

- In both relay protocol decoders, bound frames and time per turn, preserve a
  synchronous first handshake frame, pause reads during continuation, and
  transfer exact residue on reset/drain.
- Adapt ssh2, system SSH, WSL child stdio, relay stdin, Unix sockets, and
  Windows named pipes behind their existing transport constructors.
- No PTY credit or session negotiation; prior-version peers keep the same
  frame format.

### Slice 3: one drain-aware legacy writer

- Add a concretely named dispatcher writer owning ordinary, bulk, control,
  sentinel, residue, and `--connect` bridge bytes.
- Route existing `RelayDispatcher.notify`, `notifyBulk`, fs/Git producers, and
  `runConnectMode` through its bounded lane admission; stop after
  `write(false)` until callback/drain.
- Because legacy `notify` is synchronous and broadcast, add a bounded
  transport-only publication record containing one encoded frame and the set
  of client generations that have not accepted it. A client returning
  `write(false)` leaves that set because Node accepted the frame; a saturated
  client is retried only for that client, and close cancels its membership.
  This is delivery bookkeeping, not source credit.
- Return producer admission to `PtyHandler`. Until a publication is admitted,
  retain it in the existing PTY pending-output owner; at its hard byte cap
  pause node-pty, then resume below low water. Cap per-client and aggregate
  publication bytes. Before Slice 5a establishes authenticated roles, treat
  every subscribed connection equally: any retained subscriber may pause that
  PTY, and only transport close cancels its membership. Do not infer or detach
  an “additional” client by constructor or connection order. Authenticated
  slow-subscriber eviction begins only after Slice 5a. Never silently drop a
  legacy PTY frame.
- Preserve the current 8 ms/1 ms PTY cadence and current replay semantics. The
  replay tail stays the chunked `RecentPtyOutputBuffer` added in
  `79ec57d04`; a later source ledger must wrap or index it rather than replace
  it with the former per-append rolling string.
- This slice bounds relay writable queues for legacy main, WSL, direct SSH,
  and detached relay socket/named-pipe clients without changing the wire. The
  separate local terminal daemon is not exercised or changed.

### Slice 4: bounded main SSH intake

- Make `SshRelaySession.wireUpPtyEvents` hand each event exactly once to a
  main-only intake under `src/main/ipc/`; SSH no longer bypasses the existing
  pending-output authority.
- Meter model admission and its emulator callback chain, reserve before
  capture, pause decoder reads at the cap, and return completion/failure
  receipts.
- Introduce transactional projection admission with a legacy immutable
  admission ID, provider generation, PTY incarnation, display interval, and
  existing sequence/`rawLength`; it has no V1 token or source-credit
  coordinate. Slice 5b extends that record to `DesktopProjectionSpan`. Keep
  local and daemon providers on their existing intake until a shared migration
  is separately justified.
- Preserve current main's ordered terminal side-effect facts and dropped-output
  DEC mode 2031 scanner snapshots across admission, salvage, rollback, transfer,
  and explicit gaps. Preserve `terminal-stream-byte-length.ts` UTF-8 accounting
  and flush boundaries for remote streams; never reuse it as source credit.
- Extend the existing Docker ACK-stall test only for behavior this slice
  implements: direct SSH/deployed relay/desktop intake and active typing.

### Slice 5a: SSH session semantics

- Add the transport-neutral `PtyConsumerSession` state machine and only the SSH
  readiness adapter decision above.
- Prove authentication, generation, capability intersection, activation fence,
  close cleanup, exact sentinel/residue transfer, and legacy fallback without
  changing PTY data frames.
- Local in-process, daemon hello, and remote-runtime adapters reuse semantics
  only when their own changes need it; they are not prerequisites for SSH V1.

### Slice 5b: direct SSH source credit

- Add the relay immutable span ledger/scheduler and tokenized cumulative ACKs
  for one direct SSH desktop/model consumer path.
- Reuse Slice 4's projection identities and transactional admission. Separate
  obligations terminal, ACK queued, and ACK published state from the first
  implementation.
- Gate the feature and retain exact same-build legacy behavior.

### Slice 5c: exit, reconnect, and replay

- Add sealed-unsettled exit, cancellation proofs, owner reconnect grace,
  token replacement, and exact transfer.
- Add a bounded source-range index beside the current
  `RecentPtyOutputBuffer`, preserving its append performance and legacy
  output.
- Do not enable reconnect V1 until late-ACK, timeout, supersession, and
  generation-close oracles pass.

### Slice 5d: required remote consumers

- Map remote `terminal.multiplex` encoded-byte ACK frames to accepted source
  ranges without changing its transport authentication or granting it an SSH
  owner lease.
- Add `ackOutputSourceRanges: 1` and an opaque echoed stream generation;
  preserve `ackOutput: 1` delta semantics for old clients and best-effort
  streams.
- Keep mobile notification replay epochs/watermarks outside terminal stream
  identity and ACK mapping; neither can settle a PTY source range.
- Extend the extracted `terminal-output-frame-chunks.ts` seam with immutable
  composite mapping input while preserving `694363805`'s code-unit scanner,
  allocation profile, sequence rounding, and equivalence benchmark.
- Add headed paired-server first, then headless `orca serve`; neither is
  inferred from Docker SSH.
- Keep best-effort remote streams outside upstream obligations.

### Slice 5e: remaining adapters and rollout

- Adapt local in-process and daemon hello only if shared session semantics
  materially reduce their own lifecycle duplication; neither must adopt SSH
  framing or source credit for the SSH release.
- Add WSL, Windows ConPTY/named-pipe, local daemon/provider, folder workspace,
  mixed-version, and prior-version-orphan evidence separately.
- Promote reliability-gate provider coverage only for topologies with recorded
  executable evidence.

Keep new lifecycle ownership out of already-large modules where a concrete
domain file is clearer. Do not add max-lines disables, generic helper modules,
native dependencies, or a per-file lint exception.

## Tests

### Unit and property tests

- accept monotonic cumulative ACKs and reject duplicates, regressions,
  over-credit, invalid numbers, wrong clients, wrong PTYs, and stale tokens;
- prove with generated span/ACK sequences that
  `sentEndSu - creditedEndSu <= windowSu`; at `window - 1`, slice a
  splittable frame to one source unit and hold an indivisible transform;
- generate merge, split, remainder, salvage, thinning, empty-transform, and
  interactive-bypass queue operations and prove ledger conservation;
- split DEC mode 2031 subscribe and withdraw sequences across chunks, then
  inject pending-cap salvage, rollback, transfer, reconnect, and source gaps;
  prove fact order, exact scanner restoration/reset, no duplicate reply, and no
  source settlement from projection metadata;
- put two clients at different display/source offsets in one shared span and
  prove no resend, skip, or early reclamation;
- cover ASCII, BMP/CJK, surrogate pairs, unpaired surrogates, JSON-escaped
  controls, and transformed spans where `rawLength !== data.length`; assert the
  budget arithmetic and reject transformed frames without valid `rawLength`;
- run one shared session-state-machine suite through trusted local,
  token-authenticated daemon, SSH socket/named-pipe, direct-stdio/WSL, and
  authenticated remote-runtime adapters; prove identical client-generation,
  capability-intersection, activation-fence, replacement, and cleanup
  semantics while keeping transport credentials and framing adapter-local;
- verify SSH session-owner election with V1 requested and with session-granted
  same-build legacy, invalid/stale credential or lease rejection, 30-second
  lease expiry, and atomic reconnect generation transfer through POSIX sockets
  and Windows named pipes; prove constructor stdout and an unproved plain
  socket are never elected, prove a direct-stdio client must present its
  ephemeral handshake credential, and cover POSIX `0600` plus Windows
  current-user ACLs;
- verify token rotation on spawn, attach, reconnect, provider replacement, and
  same-client duplicate attach/spawn; replacement must cancel the old token
  once, report its exact remaining span, and transfer only matching recovery
  coverage while canceling the already-checkpointed prefix without re-ingest,
  duplicate output, or an open cursor;
- verify metadata response callbacks precede source-ranged recovery and live
  data in V1 and session-granted legacy, including saturation with older
  control; use
  all-control-character 512 Ki-su gaps and multi-PTY serialize snapshots to
  prove bodies never enter the 1 MiB control queue;
- feed response, recovery, completion fence, and first live data in one decoder
  turn; prove `beforeResolve` holds the known token, recovery/hold draining
  yields at 32 Ki su/64 frames/4 ms, restore snapshots never reach the model,
  and exact gap spans reach it once;
- reject wrong-incarnation checkpoints and checkpoints below old credit or
  beyond retained live end; require a token-free `restoreRequired` response
  with no partial recovery or forward clamping;
- send two identical replay snapshots for distinct tokens within one second and
  prove both source-ranged restore projections, including transformed records,
  while neither wall-clock-dedupes model input;
- retry an operation-ID spawn after commit/before response from a new client;
  prove it receives a fresh subscription and the stale client cannot ACK;
- assert `write(false)` admits exactly one frame, preserves the control reserve,
  and admits no ordinary later frame before drain;
- inject asynchronous Node write-callback errors for session grants, token
  activation, recovery completion, exit, and ACK publication; prove none
  advance state and the client generation closes with exact cancellation;
- reject a PTY subscription whose empty non-reserved sink capacity is below
  8 KiB; prove every admitted transformed span remains writable;
- saturate relay fs/Git bulk, slice it below non-reserved capacity, and bound
  cancellation, keepalive, ACK, immediate echo, and control latency while bulk
  completes;
- assert sentinel, handshake residue, and connect-mode socket data use one
  stdout writer in FIFO order under saturation;
- assert close, error, detach, invalidate, replacement, reset, and dispose
  settle/cancel each callback, token, and pause epoch exactly once;
- cover every lifecycle-table row and reject any
  `received != open + transferring + settled + transferred + canceled` state;
- require `pty.deliveryCanceled` or generation-close proof for every
  relay-initiated cancel and reject stale cancellation notifications;
- delay headless-emulator callbacks indefinitely; prove per-PTY/global model
  queues and the one-frame intake slot plateau, upstream credit stops, low-water
  resume is exact, and emulator rejection cancels rather than credits;
- while model admission is blocked, place cancellation/control behind a
  bounded PTY burst; prove the 1 MiB/64-frame reserve services it without
  reordering data, and prove reserve exhaustion pauses reads then closes the
  provider at the deadline with cleanup proof;
- under the same pressure, inject `data -> pty.exit` and
  `recovery data -> pty.recoveryComplete`; prove both lifecycle fences remain
  behind their token's quarantined data, while a same-token cancellation proof
  bypasses only after atomically canceling that prefix;
- reconnect and supersede with queued plus in-flight emulator work; prove the
  migration fence either checkpoints after the final guarded receipt or times
  out to a model-generation reset/restore, with no late mutation or duplicate
  gap ingestion;
- prove renderer ACK/heal/write-off on V1 settles/transfers via display ranges
  and emits no legacy `acknowledgeDataEvent` wire delta;
- admit interleaved spans from two token generations and prove every desktop
  operation resolves the immutable span ID, PTY incarnation, delivery token,
  source/display interval, and transform metadata; inject model-reservation,
  projection-admission, send, merge/split, salvage, reload, and replacement
  failure at each transaction boundary and prove rollback or exact transfer;
- generate remote UTF-8, JSON-escaped, transformed, split, and composite frames;
  keep legacy `ackOutput: 1` delta ACKs outside source obligations; negotiate
  `ackOutputSourceRanges: 1`, then apply partial, excessive, and stale-generation
  cumulative ACKs and prove excessive rejection plus source settlement only at
  recorded frame boundaries, with send-stop without auto-transfer at the cap
  and atomic mapping transfer on an explicit reconnect/detach;
- feed current mobile notification epochs and watermarks into terminal ACK
  handlers and prove they are rejected without changing any source obligation;
- extend `terminal-output-frame-chunks-equivalence.test.ts` so composite source
  identity preserves the current code-unit chunk text, encoded bytes, sequence
  rounding, and allocation/performance contract;
- retain `terminal-stream-byte-length.test.ts` equivalence at its native-call
  floor and over-limit boundary so transport byte accounting and batch flushes
  cannot silently become source-unit accounting;
- hold desktop parse ACKs while a lossless mobile/web consumer advances; prove
  desktop transfer to model restore allows upstream credit to continue;
- cover pause/resume hysteresis and re-entrant output/exit callbacks;
- drive `SshPtyProvider.pauseProducer`/`resumeProducer` through
  `pty.setDeliveryPaused`; prove token/generation scoping, idempotency, native
  pause when all required deliveries are ineligible, and continued progress
  for a healthy additional subscriber;
- run one slow and one healthy client, verify only the slow client is detached;
- run no clients, verify no live pending data, bounded replay, and an unpaused
  producer outside reconnect grace;
- verify exit follows data and never bypasses the window; after the exit write
  callback, keep the sealed token and uncredited suffix live, accept a late
  cumulative ACK, advance main `ackPublishedEndSu` only from its write callback,
  and close the relay record only after it applies that ACK; separately prove
  timeout publishes cancellation or uses generation-close proof and affects
  only the stalled PTY token;
- receive exit with queued and in-flight emulator writes plus desktop and
  remote mappings; prove main delays `runtime.onPtyExit`, renderer exit, model
  disposal, and subscription cleanup until prior owners settle/transfer, and
  prove deadline first cancels only the exited token, rejects late generation
  callbacks, and reports incomplete restore-required exit; separately make the
  cancellation proof fail and prove only then the provider closes;
- verify round-robin progress across 50 continuously active PTYs;
- verify spans are freed only after all divergent cursors advance, cancel, or
  transfer;
- test every source-unit and byte budget at limit minus one, limit, and plus
  one, including global low-water hysteresis and legacy per-client/relay byte
  publication caps plus their drain-owned low waters;
- verify decoder order, synchronous first frame, bounded yields, transport
  pause/resume through ssh2, system SSH, WSL child stdio, stdin, Unix socket,
  and named-pipe adapters, reset cancellation, partial 16 MiB frames, input-cap
  close, oversized discard, and exact handshake residue;
- keep an unacked header across decoder/read self-pause and writer saturation;
  prove resume rebases both health clocks, coalesces keepalives, caps timestamp
  entries, and gives a full timeout window;
- feed hostile `ack=0xffffffff` and prove work is proportional to pending map
  size, never the numeric ACK range;
- prove terminal obligations advance `obligationsTerminalEndSu` before any ACK
  write, coalescing advances `ackQueuedEndSu`, callbacks alone advance
  `ackPublishedEndSu`, and cleanup waits for the published end; cover failed
  writes, cumulative retries, at most 64 entries, 8 ms/64 Ki-su flush rules,
  and input fairness;
- fuzz frame boundaries, JSON sizes, reconnect timing, transport data during a
  decoder continuation, and scalar-safe Unicode splits;
- exercise same-build negotiated and main-disabled modes, reject a manually
  mismatched `.version`, and identify—but do not adopt or kill—an orphaned
  prior-version daemon;
- verify the session grant rejects unrequested versions and zero, negative,
  excessive, non-finite, or unsafe windows.

Use a deterministic fake sink that records accepted frames separately from its
saturation signal. Use a fake native PTY whose `pause()` can synchronously emit
one last chunk to prove the transient overshoot bound.

### Integration and E2E

The existing `tests/e2e/ssh-docker-relay-perf.spec.ts` is baseline evidence,
not V1 evidence. Its ACK-stall case holds desktop renderer ACKs, builds
main-to-renderer pressure, and checks active typing responsiveness through
direct SSH and the deployed relay. It does not saturate relay stdout/socket
writable queues, pause the remote PTY, exercise source-credit ACKs, prove model
admission bounds, or create a paired Orca runtime.

Add Docker assertions only after the corresponding runtime slice exists:

1. Slice 3 saturates actual direct-SSH/deployed-relay stdio or socket output,
   proves `write(false)` stops later ordinary frames, writable length
   plateaus, control progresses, and interactive echo stays bounded.
2. Slice 4 stalls main model admission and desktop ACKs independently, proves
   charged intake plateaus, and preserves the current active-typing oracle.
3. Slices 5b/5c exhaust the negotiated source window, exercise sealed-exit late
   ACK and cancellation, reconnects a new owner generation, rejects stale
   ACKs, and verifies exact model/renderer output.
4. A separate concurrent bulk case proves the writer reserve and completion.

Docker SSH proves the Linux SSH provider/relay path only. It must never be
reported as headed paired-server, headless `orca serve`, remote-runtime
lossless subscription, macOS node-pty, Windows ConPTY/named pipe, or WSL
evidence.

Run paired-runtime coverage separately when Slice 5d maps remote consumers:

| Topology                                       | Required oracle                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Headed paired desktop server + separate client | host-owned PTY identity, source mapping, client ACK/restore, reconnect, and cleanup         |
| Headless `orca serve` + same client flow       | identical source settlement plus headless model admission/startup ownership                 |
| Direct Docker SSH                              | deployed relay transport, main desktop intake, real remote process, writable/drain behavior |
| WSL child stdio                                | sentinel/residue, read pause, writer drain, no POSIX-path assumptions                       |
| Windows native                                 | ConPTY pause/resume and named-pipe callbacks/drain                                          |
| Local daemon                                   | authenticated paired hello and exact-version legacy fallback                                |
| Local provider                                 | direct semantic instantiation with no relay framing                                         |

Each topology also runs in a folder workspace fixture with no `.git`; source
identity and cleanup never depend on worktree metadata. Prior-version daemons
remain version-scoped legacy processes: report them, do not negotiate V1,
adopt their PTYs, or claim the new main bounds their memory. Keep any new
native artifact compatible with Ubuntu 20.04/glibc 2.31; this design itself
adds none.

The current
`terminal-performance.output-backpressure-budget` reliability gate is
experimental and partial. It lists local, daemon, SSH, and remote-runtime
providers, but `coveredProviders` is empty and its executable evidence is
local macOS main-to-renderer/runtime behavior. Slice 3 adds relay
write/drain evidence, Slice 4 adds SSH intake/model admission, Slices 5b/5c add
source-credit lifecycle, and Slices 5d/5e add topology-specific runs before any
provider is marked covered. This documentation PR does not change or promote
that gate and does not claim unimplemented runtime behavior was exercised.

## Rollout

Land V1 behind a main runtime gate and a relay advertisement launch policy.
Tests and development enable both. Main never negotiates merely because a
long-lived relay advertises; its gate is the final authority. Fresh POSIX and
Windows launch commands carry the explicit advertisement argument rather than
assuming a local environment variable reaches the remote process.

Sink drain, the reserved writer lane, stdout serialization, bounded decoder
work, bulk admission, and hostile header-ACK hardening remain enabled
independently. Same-build gate-off sessions use the bounded legacy writer but
do not wait for V1 credit. A prior-version orphan remains governed by its own
binary and cleanup.

Rollout stages:

1. land Slices 1-4 independently under legacy framing, with each narrow
   reliability oracle green before the next slice;
2. add Slices 5a-5c behind the main gate and relay advertisement, initially in
   unit/service contracts and direct Docker SSH only;
3. add Slices 5d/5e for headed paired, headless, WSL, Windows, local-daemon,
   local-provider, and folder-workspace evidence before marking those
   providers/topologies covered;
4. run an internal same-build canary comparing gate-off and V1 sink,
   model-admission, latency, sealed-exit, recovery, and reconnect metrics while
   separately counting orphan prior-version daemons;
5. default on only after zero ordering/data-loss failures and stable memory
   plateaus for one release cycle; remove the flag only after same-build legacy
   fallback and versioned-orphan cleanup stay healthy through the supported
   upgrade window.

Kill-switch behavior is explicit:

1. Disable the main gate to stop all new V1 negotiations against the
   same-build detached relay.
2. For each live token, stop new desktop membership changes, flush eligible
   cumulative ACKs, and retain
   `obligationsTerminalEndSu`/`ackQueuedEndSu`/`ackPublishedEndSu` until their
   callbacks settle. Send `pty.cancelDelivery` for every remaining active or
   sealed-unsettled token and wait up to 10 seconds for cancellation proof.
3. Reattach the same PTYs in bounded waves without requesting V1. Failure to
   prove cancellation closes/reconnects the client so relay generation cleanup
   is the proof; local ledgers and desktop range identities are not discarded
   earlier.
4. Changing the relay launch policy affects fresh processes. Replacing a
   long-lived remote relay is required only to remove its implementation or
   advertisement, not to make a gated main decline the feature.

Rollback never mutates a live token into legacy mode. The remote process may
remain alive throughout a successful cancel/reattach rotation. An orphaned
prior-version daemon is outside this sequence and is only observed until its
own version-scoped cleanup.

Release criteria:

- no unbounded increase across 30-minute desktop-only, slow-model, and required
  lossless-consumer floods;
- relay and main stay within the documented budgets plus 25% allocator slack;
- active echo p95 remains below 100 ms under a background flood;
- exact logical output sequence after resume;
- no leaked obligations, writer callbacks, drain waiters, cursors, tokens,
  decoder tasks, or paused PTYs;
- no false dead-link reconnect across a 30-minute saturated/self-paused run;
- bounded time-to-last-reattach with one injected per-PTY failure;
- same-build gate modes, manual mismatch rejection, orphan reporting, and
  Linux/macOS/Windows/WSL smoke tests pass.

## Calibrated findings and non-goals

- The liveness risk is real for transport saturation and self-paused decoding.
  A renderer-only stall is absorbed by bounded projection transfer/restore
  while required-model credit continues. A stalled model admission or
  negotiated lossless remote consumer exhausts its window and pauses the
  native PTY; tests keep these distinct.
- V1 uses logical priority lanes and reserved writable capacity, not a second
  SSH channel. Adding a physical control channel would widen handshake,
  reconnect, system-SSH, and legacy compatibility scope without being required
  once PTY bursts and decoder pauses are bounded.
- There is no arbitrary 16-socket cap. Only PTY-subscribing clients are capped;
  short-lived remote CLI clients remain independent.
- A 60-second watchdog may warn about an old open obligation, but it cannot
  force-credit data. Recovery must use a proven transfer or token cancellation.
- Reconnect-grace data is a bounded live-delivery owner, not an expansion of the
  100 Ki replay-tail contract. Expiry is an explicit data gap, never silent
  truncation.
- Content-hashed endpoints make mixed production binaries unreachable. The
  real upgrade skew is an orphaned prior-version daemon outside the new main's
  kill switch; V1 reports but cannot adopt, cancel, or retroactively bound it.
- Preserving the real exit code for a PTY that exits before any new client
  reattaches would require attach-visible tombstone retention. V1 documents and
  tests the existing synthetic `-1` fallback instead of coupling that separate
  product change to backpressure.

## Reference-commit assessment

Retain from `1500a92904` the useful concepts of generation tokens, client
isolation, pause/resume, targeted dispatcher sends, cleanup of stale credits,
and slow-client eviction.

Do not reproduce these behaviors:

- ordinary notifications continuing to write after `write(false)`;
- delta ACKs without cumulative token scope;
- automatic live broadcast to every connected client;
- force-flushing final PTY output beyond the credit window;
- per-client windows without aggregate retained-memory budgets;
- synchronous all-frame draining;
- assuming `256 Ki × 50 PTYs × N clients` is itself a safe memory bound.

This design makes writable-drain state, application credit, retained memory,
and decoder CPU four explicit and independently enforced bounds.

## Platform and workspace requirements

The relay can run on a native macOS, Linux, Windows, or WSL host reached over
SSH. Use Node stream APIs and runtime platform checks; do not assume POSIX file
descriptors, path separators, signals, or Unix sockets. Windows uses ConPTY and
named pipes, while POSIX uses node-pty and Unix sockets, but both must expose
the same idempotent pause/resume and sink state contract.

Network latency changes ACK cadence but not the window invariant. A
high-bandwidth/high-latency SSH link may need later window tuning based on
telemetry; it must not receive an unbounded adaptive window. SSH disconnects
are normal lifecycle events, not exceptional shortcuts around cleanup.

No part of subscription identity or cleanup may depend on `.git`, a worktree
ID, or a Git provider. Folder workspaces use the same connection, PTY, and
client generations as Git worktrees. Bulk Git changes only slice and schedule
existing response frames; they add no Git command, provider-specific behavior,
or requirement beyond the Git 2.25 core-workflow baseline.
