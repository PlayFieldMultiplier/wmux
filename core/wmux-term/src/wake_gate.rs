//! Coalesces worker-thread wakes into at most one queued JS callback.
//!
//! The transport's wake is a threadsafe function with a queue of one. A call
//! into a full queue fails, and napi-rs does not free the boxed payload of a
//! failed call, so every surplus wake leaked. The gate keeps a second call
//! from being made while one is still queued.
//!
//! No wake is lost: `pending` is true only between a successful enqueue and
//! the dispatch that clears it. Node frees the queue slot before it runs the
//! callback, so a re-arm after `disarm` always finds room. A worker publishes
//! its data, then arms. If it finds `pending` already set, that wake has not
//! been dispatched yet, and the drain it triggers runs after `disarm` and
//! sees the data. The SeqCst fences on both sides order the data access
//! against the flag access (the store-buffer case).
use std::sync::atomic::{fence, AtomicBool, Ordering};

#[derive(Default)]
pub(crate) struct WakeGate {
    pending: AtomicBool,
}

impl WakeGate {
    /// Call after publishing data. True means the caller must enqueue a wake;
    /// false means a queued wake that has not run yet will cover this data.
    pub(crate) fn arm(&self) -> bool {
        fence(Ordering::SeqCst);
        self.pending
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Call on the JS thread when the wake is dispatched, before any data is
    /// read. Also call after a failed enqueue so a later event can retry.
    pub(crate) fn disarm(&self) {
        self.pending.store(false, Ordering::SeqCst);
        fence(Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::WakeGate;
    use std::sync::mpsc::{channel, sync_channel, TryRecvError, TrySendError};
    use std::sync::Arc;

    #[test]
    fn arms_once_until_disarmed() {
        let gate = WakeGate::default();
        assert!(gate.arm());
        assert!(!gate.arm());
        assert!(!gate.arm());
        gate.disarm();
        assert!(gate.arm());
    }

    #[test]
    fn never_fills_a_one_slot_queue_and_loses_no_data() {
        const ITEMS: usize = 200_000;
        let gate = Arc::new(WakeGate::default());
        // A one-slot queue models the threadsafe function's max_queue_size 1.
        let (wake_tx, wake_rx) = sync_channel::<()>(1);
        let (data_tx, data_rx) = channel::<usize>();
        let producer_gate = gate.clone();
        let producer = std::thread::spawn(move || {
            let wake = |gate: &WakeGate| {
                if gate.arm() {
                    match wake_tx.try_send(()) {
                        Ok(()) => {}
                        Err(TrySendError::Full(())) => panic!("wake hit a full queue"),
                        Err(TrySendError::Disconnected(())) => unreachable!(),
                    }
                }
            };
            for item in 0..ITEMS {
                data_tx.send(item).unwrap();
                wake(&producer_gate);
            }
            drop(data_tx);
            wake(&producer_gate);
        });
        let mut received = 0;
        'outer: loop {
            // A lost wake would stall here instead of draining the rest.
            wake_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("wake lost");
            gate.disarm();
            loop {
                match data_rx.try_recv() {
                    Ok(item) => {
                        assert_eq!(item, received);
                        received += 1;
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => break 'outer,
                }
            }
        }
        producer.join().unwrap();
        assert_eq!(received, ITEMS);
    }
}
