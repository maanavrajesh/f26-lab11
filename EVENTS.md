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

### Before your fix

**The run.** Paste what `npm run demo:replay` printed without editing it. A TA
may ask you about it in milestone 3.

**Your prediction against the run.** Where they agree and where they do not.

### Your fix

**The diff.** Paste it.

**What your fix uses to decide what to do on a second delivery, and what it
does not protect.** One or two lines.

### After your fix

**The run.** Paste what `npm run demo:replay` printed on the fixed code.

**What stays the same across its three states.** Name the numbers you
compared.

---

## Milestone 3: a delivery that stops halfway

### The failure

**The run.** Run `npm run demo:failure` and paste what the delivery left
behind (the ledger, the provider, and the dead-letter list).

### Your recovery

**What, if anything, the failed delivery left undone.**

**The option you took and its evidence.** If you redelivered the
message, paste the state after the redelivery and the bus log line for that
message. If you left the message for a person to handle, write the runbook line
they would follow, and name which fields of the dead-lettered message they read to
follow it and what each one tells them.

### The other option

**What the option you did not take would have cost.** One line, in terms of who
does the work, when the organizer gets their money, and what has to be true for
it to be safe.
