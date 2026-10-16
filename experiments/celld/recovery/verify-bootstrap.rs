//! Deterministic OFFLINE slices of the pinned native decision core.
//! No storage, actor, networking, production node lease or regional authorization.
use celld_logic::{on_event, CasGuard, CasOutcome, Config, Effect, Event, OwnerRecord, State};
fn state(node: &str) -> State {
    State::new(node, Config {
        max_resident: 4, max_activations: 4, max_evictions: 1, max_releases: 1,
        max_outbound_websockets: 1, ownership_on_evict: Default::default(),
        // Explicitly isolate cell bootstrap from node-lease acquisition.
        // This is NOT a production setting or a lease/fencing runtime test.
        require_node_lease: false, peer_protocol: 1, operation_deadline_ms: Some(1000),
        owner_log_recovery_backoff_ms: 100, owner_log_recovery_attempts: 1,
        alarm_resident_ms: 0, idle_evict_ms: None, pressure: Default::default(),
    })
}
fn claim(state: &mut State, owner: Option<OwnerRecord>) -> Vec<Effect> {
    let effects = on_event(state, Event::Request { request: 1, cell: "fixture-cell".into() });
    let reads: Vec<_> = effects.iter().filter_map(|effect| match effect {
        Effect::ReadOwner { op, cell } if cell == "fixture-cell" => Some(*op), _ => None,
    }).collect();
    assert_eq!(reads.len(), 1, "exactly one owner read required");
    on_event(state, Event::OwnerRead { op: reads[0], now_ms: 0, result: Ok(owner) })
}
fn owner_cas(effects: &[Effect]) -> (u64, u64, CasGuard) {
    let claims: Vec<_> = effects.iter().filter_map(|effect| match effect {
        Effect::CasOwner { op, epoch, guard, .. } => Some((*op, *epoch, guard.clone())), _ => None,
    }).collect();
    assert_eq!(claims.len(), 1, "exactly one native CAS required");
    claims[0].clone()
}
fn restore_spec(effects: &[Effect]) -> celld_logic::RestoreSpec {
    let restores: Vec<_> = effects.iter().filter_map(|effect| match effect {
        Effect::Restore { spec, .. } => Some(spec.clone()), _ => None,
    }).collect();
    assert_eq!(restores.len(), 1, "exactly one restore effect required");
    restores[0].clone()
}
fn main() {
    let mut absent = state("fixture-a");
    let (op, epoch, guard) = owner_cas(&claim(&mut absent, None));
    assert_eq!(epoch, 1); assert_eq!(guard, CasGuard::Absent);
    let fresh = restore_spec(&on_event(&mut absent, Event::OwnerCasCompleted { op, result: Ok(CasOutcome::Applied) }));
    assert_eq!(fresh.epoch, 1); assert!(fresh.fresh);
    println!("PASS\tabsent-owner\tepoch=1\tfresh=true");

    let mut released = state("fixture-b");
    let record = OwnerRecord { node: None, epoch: 7, etag: "fixture-release-version".into() };
    let (op, epoch, guard) = owner_cas(&claim(&mut released, Some(record)));
    assert_eq!(epoch, 8); assert_eq!(guard, CasGuard::Match("fixture-release-version".into()));
    let inherited = restore_spec(&on_event(&mut released, Event::OwnerCasCompleted { op, result: Ok(CasOutcome::Applied) }));
    assert_eq!(inherited.epoch, 8); assert!(!inherited.fresh); assert!(inherited.took_over);
    println!("PASS\treleased-owner\tepoch=8\tfresh=false\tconditional-version-match=true");

    let mut rejected = state("fixture-rejected");
    let (op, _, _) = owner_cas(&claim(&mut rejected, None));
    let effects = on_event(&mut rejected, Event::OwnerCasCompleted { op, result: Ok(CasOutcome::Rejected) });
    assert!(!effects.iter().any(|effect| matches!(effect, Effect::Restore {..} | Effect::StartRuntime {..})));
    println!("PASS\trejected-cas\tno-immediate-restore-or-runtime");

    let mut exhausted = state("fixture-exhausted");
    let effects = claim(&mut exhausted, Some(OwnerRecord { node: None, epoch: u64::MAX, etag: "fixture-max".into() }));
    assert!(!effects.iter().any(|effect| matches!(effect, Effect::CasOwner {..} | Effect::Restore {..} | Effect::StartRuntime {..})));
    println!("PASS\tepoch-exhaustion\tno-immediate-claim-or-restore");

    // Separate observations have no shared authority in this pure-core slice.
    // Both claim absence; no CAS is executed and no mutation is committed.
    let mut island_a = state("fixture-island-a");
    let mut island_b = state("fixture-island-b");
    let (_, epoch_a, guard_a) = owner_cas(&claim(&mut island_a, None));
    let (_, epoch_b, guard_b) = owner_cas(&claim(&mut island_b, None));
    assert_eq!((epoch_a, guard_a), (1, CasGuard::Absent));
    assert_eq!((epoch_b, guard_b), (1, CasGuard::Absent));
    println!("PASS\tindependent-absent-observations\tboth-propose-epoch=1\tno-global-arbitration-in-core");
    println!("LIMIT\tdeterministic-bootstrap-only; node-leases-disabled; no-AWS-no-actors-no-regional-fence-no-import");
}
