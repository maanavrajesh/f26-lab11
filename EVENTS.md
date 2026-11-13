# EVENTS.md

One section per milestone. Fill each one in order as you go.

The prediction in milestone 2 should be written before you run the replay. That is the
part a TA will ask about.

Keep it short and specific. Point at operations, call sites, and what a caller
gets back.

---

## Milestone 1: what runs in the request path, and what runs after it

### The operations table

One row per operation. Read the code, not the file
names. "As wired today" is what the code does now. "Your call" is what you
would do if this were your service. List up to eight operations, and remove
the rows you don't use.

| # | Operation | As wired today | Your call | Why (in one line) |
|---|---|---|---|---|
| 1 | Validate request, check for a clash, price, and save the booking (`BookingService.book`; `cancel` does the same for marking a booking cancelled and computing the refund amount) | Synchronous, in the request path | Synchronous | The caller's answer ("you have the room", "that slot is taken", "you are owed $85") *is* this work, and the clash check must see the latest writes. |
| 2 | Index the booking for the room-finder (`searchIndex.indexBooking`, `bookingService.ts:94`) | Synchronous, in the request path, **before** `store.save` | Event-driven: a subscriber on `booking.confirmed` (and one on `booking.cancelled` to remove the row) | The search index is a derived read model for a different page; a few minutes of staleness is fine, and its outage must not block bookings. |
| 3 | Audit record (`audit.record` in `book`/`cancel`) | Synchronous, in-process | Synchronous | It is a local append that cannot fail independently, and an audit trail that can silently miss a booking is worse than none. |
| 4 | Confirmation / release email (`EmailConfirmationHandler`) | Event on `booking.confirmed` / `booking.cancelled` | Event-driven | The organizer does not need the mail before the page answers, and a mail relay outage should delay mail, not bookings. Replay-safe: the outbox is keyed by template + booking id. |
| 5 | Receipt rendering (`ReceiptGenerator`) | Event on `booking.confirmed` | Event-driven | The receipt is downloaded later; rendering is a side effect keyed by booking id, so a redelivery overwrites rather than duplicates. |
| 6 | Reminder scheduling / dropping (`ReminderScheduler`) | Event on `booking.confirmed` / `booking.cancelled` | Event-driven | The reminder is due 30 minutes before the booking, hours later; it is keyed by booking id and re-reads the store, so replays are harmless. |
| 7 | Dashboard stats (`StatsUpdater`) | Event on both booking events | Event-driven | Ops dashboard tolerates lag; it recomputes from the store, so any number of deliveries gives the same numbers. |
| 8 | Refund: ledger entry + payment provider (`RefundLedger`) | Event on `refund.requested` | Event-driven, but the handler must be idempotent | Cancellation should succeed even if the payment provider is down, but at-least-once delivery means a replay must not pay twice (milestone 2). |

### Two calls in detail

**Row 2: indexing the booking for the room-finder. Move it onto the bus.**
The caller of `book` is a person at the reservations page or the front-desk
kiosk, and what they need *right now* is a yes or no: is the room theirs. That
answer depends only on validation, the clash check against the booking store,
and the store write. It does not depend on the search cluster at all. The
search index exists for a different page (the room-finder) that reads it later,
and that page already tolerates being blank for half an hour during
maintenance. Today, though, the index write sits in the request path before
`store.save`, so when the cluster is unavailable the caller gets a
`SearchIndexUnavailableError` and no booking. Wired as a subscriber on
`booking.confirmed`, a search outage instead becomes a dead-lettered index
update. The booking is saved, the caller gets their booking back, and the
room-finder is stale until the cluster returns and the dead letters are
redelivered. Indexing by booking id is an upsert (`documents.set`), so a
redelivery is naturally idempotent. A matching subscriber on
`booking.cancelled` should remove the row; today nothing but the nightly sweep
does, and the sweep already treats an unavailable cluster as "defer, try next
run". That is the same tolerance `book` should have had.

**Row 8: the refund. Keep it on the bus, and make the handler idempotent.**
The caller of `cancel` needs to know, before the page answers, that the room is
released and how much they will get back. `cancel` already computes the amount
synchronously and returns it as `refundCents`. They do not need the money
to have moved before the response; a refund that settles a few seconds or
minutes later is normal. If the payment call were synchronous, a provider
outage would block cancellations, the same coupling mistake as row 2, now
pointed at the payment provider. On the bus, a provider failure becomes a dead
letter and the cancellation still succeeds. The price of that decoupling is
that the bus is at-least-once: a redelivery (by an operator, or by a broker
that missed an ack) hands the handler the same message again, and because this
handler moves real money, it must recognise a message it has already paid.
Milestone 2 does that.

### The incident

**The call behind `TICKET.md`.** `src/service/bookingService.ts`, method
`BookingService.book`, line 94:

```ts
this.searchIndex.indexBooking(booking, room, now);
```

When the search cluster is down, `SearchIndexClient.requireAvailable` throws
`SearchIndexUnavailableError` ("search index is unavailable"). Nothing in
`book` catches it, so it propagates straight out to the caller (the web page
and the kiosk) as an error. It is not even a `BookingError`, so to the caller
it looks like a server failure rather than a booking rule. Because the call
comes *before* `store.save` (line 95), the audit record, and the
`booking.confirmed` publish (line 114), nothing is saved and no event goes out:
the booking simply does not exist. That matches the ticket: 22 failed bookings
from 13:12 to 13:47, recovery within a minute of the cluster returning, and no
one touching reservations. Cancellations kept working because `cancel` never
calls the search index, and confirmation mail for earlier bookings went out
because those messages had already been delivered. Booking a room needs
nothing from the search cluster; only the room-finder does.

---

## Milestone 2: what a second delivery does

### Your prediction (before you run anything)

**What you expect `redeliver` on a refund message to do.** Name what you expect
to change in the ledger, at the payment provider, and in the bus log. Write it
down, then run the demo.

`RefundLedger.handle` checks nothing: it appends an entry, then calls
`gateway.refund`. The bus keeps no record of who has seen what. So I expect:

- **After the cancellation:** ledger 1 entry (`led-1`, $85.00), gateway 1
  call / 1 settlement (`stl-1`), $85.00 returned, 0 dead letters.
- **After one redelivery:** a second ledger entry `led-2` for the *same*
  booking, gateway 2 calls / 2 settlements (`stl-2`), $170.00 returned. The
  organizer has been paid twice for one cancellation.
- **After two redeliveries:** 3 ledger entries, 3 calls, 3 settlements,
  $255.00 returned.
- **Bus log:** `msg-1 booking.confirmed deliveries=1`, `msg-2
  booking.cancelled deliveries=1`, `msg-3 refund.requested deliveries=3`. No
  dead letters, because nothing throws. The ledger and the provider agree
  with each other, and both are wrong.

### Before your fix

**The run.** Paste what `npm run demo:replay` printed without editing it. A TA
may ask you about it in milestone 3.

```
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 2
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 2
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
money returned in total: $170.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 3
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-3 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 3
gateway settlements: 3
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
  stl-3 bk-1001 $85.00
money returned in total: $255.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**Your prediction against the run.** They agree on every number. Each
delivery of `msg-3` wrote one more ledger entry (`led-1` to `led-3`, all
for `bk-1001`) and made one more call to the provider, and each call settled
(`stl-1` to `stl-3`), so $255.00 went back for an $85.00 booking. The bus log
shows `msg-3 deliveries=3`, and the dead-letter list stays empty. That last
point is the dangerous part: the double payment raises no error anywhere. The
ledger and the provider agree with each other ($255 = $255), so a
reconciliation between them would not catch it either. Only checking against
what the cancellation actually owed ($85) shows the error.

### Your fix

**The diff.** Paste it.

```diff
diff --git a/src/handlers/refundLedger.ts b/src/handlers/refundLedger.ts
index 600ffca..0df83ce 100644
--- a/src/handlers/refundLedger.ts
+++ b/src/handlers/refundLedger.ts
@@ -10,6 +10,8 @@ export interface LedgerEntry {
   amountCents: number;
   reason: string;
   recordedAtMinute: number;
+  /** The refund message this entry was written for: the idempotency key. */
+  messageId: string;
 }
 
 /**
@@ -19,11 +21,22 @@ export interface LedgerEntry {
  * payment provider for the same amount. The ledger is append only: entries are
  * numbered in the order they were written, and nothing edits or removes one
  * after the fact.
+ *
+ * The bus delivers at least once, so the same message id can arrive any number
+ * of times. The handler uses the message id as an idempotency key and guards
+ * each of its two effects separately:
+ *
+ * - the ledger entry is written only if no entry carries this message id yet;
+ * - the payment is sent only if no settlement has been recorded for this
+ *   message id yet. The id is recorded only after the provider accepted the
+ *   refund, so a delivery that failed at the provider is retried on the next
+ *   delivery instead of being skipped.
  */
 export class RefundLedger implements Subscriber<RefundRequested> {
   readonly name = 'RefundLedger';
 
   private readonly entries: LedgerEntry[] = [];
+  private readonly settledMessageIds = new Set<string>();
   private readonly gateway: PaymentGateway;
 
   constructor(gateway: PaymentGateway) {
@@ -32,15 +45,21 @@ export class RefundLedger implements Subscriber<RefundRequested> {
 
   handle(message: Message<RefundRequested>): void {
     const event = message.payload;
-    this.entries.push({
-      entryId: `led-${this.entries.length + 1}`,
-      bookingId: event.bookingId,
-      organizer: event.organizer,
-      amountCents: event.amountCents,
-      reason: event.reason,
-      recordedAtMinute: message.publishedAtMinute,
-    });
-    this.gateway.refund(event.bookingId, event.amountCents);
+    if (!this.entries.some((entry) => entry.messageId === message.id)) {
+      this.entries.push({
+        entryId: `led-${this.entries.length + 1}`,
+        bookingId: event.bookingId,
+        organizer: event.organizer,
+        amountCents: event.amountCents,
+        reason: event.reason,
+        recordedAtMinute: message.publishedAtMinute,
+        messageId: message.id,
+      });
+    }
+    if (!this.settledMessageIds.has(message.id)) {
+      this.gateway.refund(event.bookingId, event.amountCents);
+      this.settledMessageIds.add(message.id);
+    }
   }
 
   /** Every ledger entry, oldest first. */
```

Tests added: two cases in `tests/handlers.test.ts` (three deliveries pay once;
provider fails, then a redelivery pays once with no second ledger entry), plus
the optional fast-check property in `tests/optionalProperty.test.ts`, now
uncommented. All three fail on the original handler and pass on the fix.

**What your fix uses to decide what to do on a second delivery, and what it
does not protect.** One or two lines.

The key is the **message id** (`msg-3`), which the bus guarantees is identical
on every redelivery. The fix checks it **separately for each effect**: the
ledger entry is skipped if an entry already carries that id, and the payment
is skipped only if the provider already *accepted* a refund for that id (the
id goes into `settledMessageIds` after `gateway.refund` returns). A delivery
that wrote the ledger entry but failed at the provider still pays on the next
delivery.

It does **not** protect against: (1) a *different* message for the same
refund. A second publish gets a new id, so dedupe by message id lets it
through (today `cancel` rejects a second cancellation, which is the only
reason that cannot happen). (2) The window between the provider settling and
the handler recording it. If the provider settles but the call times out, or
the process dies before `settledMessageIds.add`, the next delivery pays
again. Closing that window needs the provider to dedupe on a key we pass it,
and this gateway API takes none. (3) A restart. The set lives in memory, so it
is lost unless it is persisted together with the ledger.

### After your fix

**The run.** Paste what `npm run demo:replay` printed on the fixed code.

```
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**What stays the same across its three states.** Name the numbers you
compared.

Across all three states (after the cancellation, after one redelivery, after
two), the numbers are identical: **ledger entries 1** (`led-1 bk-1001
$85.00`), **gateway calls 1**, **gateway settlements 1** (`stl-1`), **money
returned $85.00**, and **dead letters 0**. Ledger total = settled total = the
$85.00 the cancellation owed. The only number that changes is the bus's
`deliveries` count for `msg-3` (it ends at 3). Redelivery still happens; it
just has no effect the second and third time. Notice that **gateway calls**
stays at 1: the fix does not even ask the provider again once a settlement is
recorded.

---

## Milestone 3: a delivery that stops halfway

### The failure

**The run.** Run `npm run demo:failure` and paste what the delivery left
behind (the ledger, the provider, and the dead-letter list).

```
armed: call 1 to the payment provider will throw
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3
the cancel call itself returned: booking is cancelled

=== after the failed delivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 0
money returned in total: $0.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=1

the refund message is in the log and in the dead-letter list. Milestone 3 asks what you do with it.
```

### Your recovery

**What, if anything, the failed delivery left undone.**

The money. `RefundLedger.handle` has two effects, and the delivery got through
only the first. It wrote `led-1 bk-1001 $85.00`, then `gateway.refund` threw on
call 1 *before anything settled*, so the provider has **0 settlements and
$0.00 returned**. The ledger now says $85.00 was refunded and the provider says
nothing was: the two disagree by exactly one refund. Everything else finished.
`cancel` returned normally (booking `cancelled`, `refundCents` 8500), because
`publish` does not throw. The bus caught the error and recorded one dead
letter (`msg-3`, attempt 1, `RefundLedger`). Nothing retries on its own, so
without action the organizer is never paid.

**The option you took and its evidence.** If you redelivered the
message, paste the state after the redelivery and the bus log line for that
message. If you left the message for a person to handle, write the runbook line
they would follow, and name which fields of the dead-lettered message they read to
follow it and what each one tells them.

**I redelivered.** At the end of `main()` in `src/demos/failureDemo.ts` I
added `app.bus.redeliver(cancellation.refundMessageId)` (guarded against
`undefined`, as in `replayDemo.ts`), then `printRefundState` and
`printMessageLog` again. `npm run typecheck` stays green.

```
redelivering msg-3

=== after the redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=2
```

The bus log line for the refund message:

```
  msg-3 refund.requested deliveries=2
```

Delivery 2 is the recovery. On that delivery the handler found an entry
already carrying `msg-3`, so it did **not** write `led-2`. It found no
settlement recorded for `msg-3`, so it called the provider (gateway calls 1 →
2), and that call settled `stl-1 $85.00`. Ledger total $85.00 = settled total
$85.00 = what was owed. The dead-letter list still shows the attempt-1 entry,
because the list is a log, not a queue, and `redeliver` removes nothing. It
gained no attempt-2 entry, which is how you tell that the redelivery
succeeded.

This works only because of the milestone 2 fix. With the original handler,
redelivery would have written `led-2` (ledger $170.00 against $85.00
settled). With a naive fix that skipped any message already in the ledger,
redelivery would have done nothing and the organizer would never be paid.
The fix had to track "paid" separately from "recorded".

### The other option

**What the option you did not take would have cost.** One line, in terms of who
does the work, when the organizer gets their money, and what has to be true for
it to be safe.

Leaving it on the dead-letter list for triage puts the work on a **person**:
they read `message.id` (`msg-3`, what to redeliver or look up),
`subscriberName` (`RefundLedger`, which effect failed), `reason` (the provider
did not answer, so a transient outage and not a bad amount), `attempt` (1, so
the first try and not a repeat offender), `failedAtMinute` (480, when, to
match against the provider's outage window), and `payload.bookingId` /
`amountCents` (`bk-1001`, 8500, what to check at the provider). Their runbook
line would be: *"Look up `bookingId` at the payment provider; if there is no
settlement for it, redeliver `message.id`, otherwise mark the dead letter
resolved."* The organizer gets their money **whenever someone gets to the
queue**: hours, or after a weekend, instead of right away. It is safe only if
the human actually checks the provider before acting. A person re-issuing the
refund by hand, or redelivering against the *un*fixed handler, double-pays
or double-books the ledger. In exchange, triage needs no idempotent handler
and puts a human in front of a failure that might not be transient.
