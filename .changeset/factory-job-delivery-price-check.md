---
'@toon-protocol/rig': patch
---

Fix `ClientJobDeliveryPort` releasing a factory-job increment's decryption
key for any PREPARE carrying the armed condition, regardless of amount.

The condition is public (it is published on the kind:7000 offer), so any
buyer could send a PREPARE for amount 0 with the advertised condition and
collect the key for free. `handleJob` now rejects a PREPARE whose `amount`
is below the armed increment's `priceUsdc` without consuming the arming, so
a correctly-priced PREPARE can still land before the payment timeout.
