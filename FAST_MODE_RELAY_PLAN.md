# Fast/Anonymous Network Mode Plan

## Locked Decisions
1. Keep a single SQLite DB file.
2. Two isolated networks:
   - `anonymous` = Tor path (current behavior).
   - `fast` = non-Tor path with Circuit Relay v2 (+ DCUtR).
3. No bridging between modes.
4. First app launch default mode is `fast`.
5. After first launch, remember and reuse last selected mode.
6. Start with one relay node, scale to many later.
7. Mode switch requires full app restart (no hot re-init in v1).
8. v1 keeps one identity/keypair across both modes.
   - Known tradeoff: cross-mode identity correlation via same peer ID is possible.
   - UI/docs must explicitly warn users of this.
9. Relay discovery in v1 is deterministic:
   - static fast bootstrap list + static relay multiaddrs.
   - DHT random-walk relay discovery is not primary in v1.

## Execution Units

### U0: Constants and mode contract
Scope:
1. Define authoritative mode enum/string union: `fast | anonymous`.
2. Define mode-specific protocol/topic/namespace constants.
3. Define fast/anonymous bootstrap config keys.

Output:
1. One constants block for network mode and per-mode protocol IDs.
2. One short architecture note in code comments showing no-bridge rule.

Done when:
1. No mode string literals are scattered outside constants/types.
2. Build passes.

### U1: Persistent setting + startup read path
Scope:
1. Add `network_mode` setting with default `fast` on first launch.
2. Read mode before node initialization.
3. Keep mode in one source of truth for the session.

Output:
1. DB/settings methods for get/set mode.
2. Startup path uses persisted mode.

Done when:
1. Fresh install starts in `fast`.
2. Restart keeps last selected mode.

### U2: Login/register mode selector UX
Scope:
1. Add `Fast <-> Anonymous` switch to login/register screen.
2. Show short explanations under the switch.
3. Persist new selection immediately (or on submit).

Output:
1. Mode selector component + integration in auth screen.

Done when:
1. User can choose mode pre-auth.
2. UI reflects persisted value on next launch.

### U3: Runtime stack split (node setup)
Scope:
1. `anonymous` path keeps current Tor behavior.
2. `fast` path disables Tor transport/bootstrap and enables relay/DCUtR path.
3. Use deterministic relay addresses in fast mode (no random-walk primary path).
4. Add startup log banner with selected mode and stack details.

Output:
1. Branching setup in node initialization by mode.
2. Mode-specific bootstrap list selection.
3. Mode-switch flow that requires full app restart.

Done when:
1. Anonymous startup still behaves exactly as before.
2. Fast startup runs without Tor dependency.
3. Switching mode does not attempt in-process node teardown/reinit.

### U4: Hard isolation enforcement (split by subsystem)
#### U4a: Core mode constants plumbing
Scope:
1. Wire mode-specific DHT protocol IDs.
2. Wire mode-specific pubsub topic prefixes.
3. Provide shared helper for mode-aware key/topic generation.

Done when:
1. All subsystems consume one mode-aware helper/constants path.

#### U4b: Username subsystem isolation
Scope:
1. Apply mode-aware key namespace for username by-name and by-peer records.
2. Update username validator/selector/lookup paths accordingly.

Done when:
1. Username records written in one mode are invisible to the other mode.

#### U4c: Direct/offline subsystem isolation
Scope:
1. Apply mode-aware namespace to direct offline buckets/keys.
2. Keep nudge/check paths mode-consistent.

Done when:
1. Offline direct messages are not cross-visible between modes.

#### U4d: Group subsystem isolation
Scope:
1. Apply mode-aware namespaces to group offline and group info records.
2. Update group validators/selectors/key parsers for both `latest` and versioned flows.

Done when:
1. Group control/data records are isolated by mode.

#### U4e: Send/receive guardrails
Scope:
1. Add explicit guards to reject cross-mode lookups/sends.
2. Add diagnostics for rejected cross-mode attempts.

Done when:
1. Accidental cross-mode operations fail fast with clear logs.

### U5: Single DB scoping rules
Scope:
1. Keep one DB file.
2. Add `network_mode` scoping only where collisions are possible.
3. Ensure list/query paths only return relevant rows for active mode.
4. Keep identity global in v1 (same peer ID across modes).
5. Make DB access APIs mode-aware where lookup keys are not globally unique.

Tables to scope explicitly in v1:
1. `chats`
2. `notifications` (if notification list is shared UI, add mode scope to avoid cross-mode bleed)
3. `bootstrap_nodes` (or separate per-mode bootstrap table/setting)
4. `group_pending_acks` (global republisher queue must not mutate other mode rows)
5. `group_pending_info_publishes` (global republisher queue must not mutate other mode rows)
6. `group_invite_delivery_acks` (invite ACK lifecycle must stay mode-local)

Group state tables in v1 (minimal strategy):
1. Do not add `network_mode` column initially to:
   - `group_key_history`
   - `group_offline_cursors`
   - `group_sender_seq`
   - `group_member_seq`
2. Treat `chats` as the primary mode boundary and ensure reads/writes reach these tables only through mode-scoped chat context.
3. If any cross-mode collision path appears in practice, promote these group tables to explicit mode scoping in a follow-up migration.

Mode-aware DB API contract (required):
1. `getChatByGroupId(groupId)` becomes mode-aware (`groupId + network_mode`).
2. Any batch/global queue fetch must accept mode:
   - `getAllPendingAcks(mode)`
   - `getDuePendingGroupInfoPublishes(mode, nowMs, limit)`
3. Delete/update helpers for queue rows must include mode in `WHERE` clause.
4. No republisher cycle may read/modify rows from both modes in one run.

Tables that remain global:
1. `encrypted_user_identities`
2. `users` (identity/profile cache only, not contact visibility source)
3. `settings` (except mode-aware keys where needed)

Contact visibility rule (required):
1. Do not render contacts from `users` directly.
2. Contact list in current mode must come from mode-scoped relationship data (for v1: mode-scoped direct chats / participants).
3. A peer first seen in `fast` must not appear as an active contact in `anonymous` unless a relationship exists in `anonymous`.

Output:
1. Minimal schema/query changes for mode scoping.
2. Migration path for existing rows.

Done when:
1. No duplicate identity setup needed.
2. No cross-mode chat contamination in UI/state.
3. Group table queries are always derived from a mode-scoped chat path.
4. Republisher queues are guaranteed mode-local by schema+query constraints.
5. Contact list only shows peers with relationships in current mode.

### U6: Relay node deployment (infrastructure)
Scope:
1. Rent one VPS and deploy one relay node first.
2. Configure resource limits, restart policy, firewall.
3. Add logs and basic health checks.

Output:
1. Live relay with stable public multiaddr.
2. Operational notes for restart and monitoring.

Done when:
1. Fast-mode clients can reserve/use relay through that node.
2. Relay survives process restart/reboot.

### U7: Fast bootstrap node deployment
Scope:
1. Deploy at least one dedicated fast bootstrap node.
2. Keep it separate from anonymous bootstrap set.

Output:
1. Fast bootstrap address list integrated into app config.

Done when:
1. Clean fast-mode startup discovers peers through fast bootstrap.

### U8: End-to-end validation and rollout
Scope:
1. Run QA matrix for both modes.
2. Validate failure and reconnect behavior.
3. Gate rollout behind internal toggle until stable.
4. Execute cross-mode safety regression checks (must-pass).

Output:
1. Test checklist and pass/fail results.
2. Release note for users about mode differences.

Done when:
1. Both modes pass critical messaging/group flows.
2. No cross-mode leakage detected.
3. No cross-mode row mutation detected in DB after mixed-mode test run.

## Short “What You Need To Do” for Server
1. Buy one Linux VPS.
2. Install Node runtime (or runtime needed by chosen relay binary) and firewall tools.
3. Open required TCP port(s) in cloud firewall + host firewall.
4. Deploy relay process as systemd service with restart policy.
5. Record relay multiaddr and add it to app fast-mode config.
6. Test from a separate machine: connect, reserve relay slot, send a test message.

## Suggested Implementation Order
1. U0 -> U1 -> U2
2. U3
3. U6 + U7
4. U4a -> U4b -> U4c -> U4d -> U4e
5. U5
6. U8

## Dependency Notes
1. U4a depends on U0 and U3.
2. U4b/U4c/U4d/U4e depend on U4a.
3. U6+U7 are needed before meaningful fast-mode validation.
4. U5 should be completed before full QA (U8).

## Non-Negotiable Safety Gates (MUST NOT BREAK)
1. Any query that can return multiple logical networks must have mode filter.
2. Any write/delete on queue/state rows must be mode-scoped or chat-scoped via mode-aware chat lookup.
3. If a mode-scoping migration fails, startup must abort migration and keep DB intact.
4. Do not ship if mixed-mode soak test shows one mode deleting/updating the other mode’s pending rows.

## Risks and Mitigations
1. Risk: single DB cross-network collisions.
   - Mitigation: explicit table-level scoping list in U5.
2. Risk: users switch mode mid-session and expect continuity.
   - Mitigation: require full app restart on mode change in v1.
3. Risk: one relay is single point of degradation.
   - Mitigation: add more relays in next step (you already plan ~10).
4. Risk: shared identity across modes weakens unlinkability.
   - Mitigation: explicit warning text + documentation in UI/help.
5. Risk: random-walk relay discovery causes flaky cold-start.
   - Mitigation: deterministic relay/bootstrap config in v1.

## Rollout Order
1. Land mode setting + UI switch.
2. Land runtime split for anonymous/fast.
3. Bring first relay + fast bootstrap online.
4. Land protocol/topic/namespace isolation (U4 split units).
5. Validate QA matrix.
6. Expand relay fleet.
