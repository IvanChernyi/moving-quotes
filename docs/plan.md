# Moving quote calculator — plan

## 1. Problem

A customer opens the moving company's web page and starts a quote. On the
calculator page they pick the items they plan to move, adjust how much each one
weighs, give the pickup and delivery addresses, pick a move date and the number
of trucks. The app suggests how many movers are needed; the customer can change
that. While they work, the page shows a live estimate built from items, total
weight, distance, trucks and movers. When the customer confirms, the price is
locked and the trucks are booked for that date. A confirmed quote can be
cancelled, but not within 7 days of the move.

## 2. The three questions

| Question | Answer |
|---|---|
| Who is it built for? | The customer planning a move, and the office that has to send trucks on the day. |
| What matters to them? | The customer: a price they can trust and that will not change once confirmed. The office: never promising more trucks on a day than it has. |
| What must stay true? | A confirmed quote does not change. A day never has more trucks booked than the fleet. A move inside 7 days cannot be cancelled. |

Two of those sentences are about a **quote**; one is about a **day**. That is
where the two aggregates come from.

## 3. Aggregates

### Quote

```
Quote {
  id,
  status: 'draft' | 'confirmed' | 'cancelled',
  lines: { lineNo, item, quantity, weightKg }[],
  pickup?, delivery?, distanceKm?,
  moveDate?,
  trucks?,
  moversOverride?,
  confirmedPriceCents?
}
```

Rules it enforces:

1. Only a draft can change. A confirmed quote is a promise.
2. Confirming needs at least one line, both addresses, a future move date, at least one truck, and enough truck capacity for the total weight.
3. A line can only be edited or removed if it exists and was not removed already.
4. Only a confirmed quote can be cancelled, and only if the move is **more than** 7 days away. Exactly 7 days is refused.

`lineNo` is assigned by the aggregate: one more than the number of lines added
so far. Pure and deterministic, so a line needs no minted id, and
`ItemRemoved` has something to point at.

### TruckDay

```
TruckDay {
  date,                                   // the stream id: one aggregate per date
  reservations: { quoteId, trucks }[]
}
```

Rule it enforces: the trucks reserved on a day never exceed the fleet size for
that day. The fleet size is reference data handed to the verb.

### Why two

"Trucks free on 20 November" is shared by every quote for that day. If it lived
inside each quote, two customers could each see the last truck and both confirm.
The noun in the sentence "a day cannot book more trucks than it has" is the day,
so the day is the aggregate. Never an aggregate inside an aggregate: the quote
only knows how many trucks it wants; the day knows who has them.

## 4. Verbs and events

Every verb is `(aggregate, input, now) => Result<Event[]>`, except `startQuote`,
which has no aggregate yet.

### Quote

| Verb | Event | Guard |
|---|---|---|
| `startQuote(quoteId, now)` | `QuoteStarted` | none |
| `addItem(quote, item, now)` | `ItemAdded { lineNo, item, quantity, weightKg }` | draft; item in the catalogue; quantity positive |
| `changeItemWeight(quote, lineNo, weightKg, now)` | `ItemWeightChanged { lineNo, weightKg }` | draft; line exists; weight positive |
| `removeItem(quote, lineNo, now)` | `ItemRemoved { lineNo }` | draft; line exists, not already removed |
| `chooseAddresses(quote, route, now)` | `AddressesChosen { pickup, delivery, distanceKm }` | draft |
| `chooseMoveDate(quote, date, now)` | `MoveDateChosen { date }` | draft; date in the future |
| `chooseTrucks(quote, count, now)` | `TrucksChosen { count }` | draft; count at least 1 |
| `chooseMovers(quote, count, now)` | `MoversChosen { count }` | draft; count at least 1 |
| `confirmQuote(quote, rates, now)` | `QuoteConfirmed { priceCents, breakdown }` | rule 2 |
| `cancelQuote(quote, now)` | `QuoteCancelled` | rule 4 |

Two events copy values from outside onto the fact, the same idea as
`priceCents` on a trade:

- `ItemAdded` copies the catalogue's default weight (or the customer's). If the catalogue changes next month, the quote keeps what it was given.
- `AddressesChosen` carries the distance fetched at that moment, so the estimate does not drift when the maps service answers differently later.

### TruckDay

| Verb | Event | Guard |
|---|---|---|
| `reserveTrucks(day, quoteId, trucks, fleetSize, now)` | `TrucksReserved { quoteId, trucks }` | free trucks ≥ trucks; quote holds nothing that day yet |
| `releaseTrucks(day, quoteId, now)` | `TrucksReleased { quoteId, trucks }` | quote holds a reservation that day |

## 5. Pure functions (not events)

- `totalWeightKg(quote)`
- `suggestedMovers(quote, rates)`: the app's number; `moversOverride` wins when set.
- `estimate(quote, rates)`: price and breakdown, recalculated on every screen while the quote is a draft. Only `QuoteConfirmed` turns it into a fact.
- `daysUntilMove(moveDate, now)`: calendar days in the company's time zone. The 7-day rule depends on it, so it gets its own boundary tests.
- `freeTrucks(day, fleetSize)`

## 6. Streams and ids

| Stream | Id | Minted by |
|---|---|---|
| `quote-<uuid>` | quote id | app layer, at `startQuote` |
| `truckday-<YYYY-MM-DD>` | the date | nobody: the date is the id |

The event store becomes generic, `EventStore<E>`, because the two streams hold
different event types.

## 7. Across two aggregates: confirm and cancel

One transaction per aggregate, so confirming and cancelling are small processes
in the app layer. The order is chosen so that a failure halfway errs on the safe
side: **holding a truck too long is safe; confirming a quote with no truck is not.**

```mermaid
sequenceDiagram
    participant UI
    participant App as app layer
    participant Q as Quote
    participant D as TruckDay
    UI->>App: confirm
    App->>Q: fold; check confirmable (pure, no event)
    App->>D: fold day; reserveTrucks
    D-->>App: TrucksReserved (append with expected seq)
    App->>Q: confirmQuote
    Q-->>App: QuoteConfirmed (append)
    Note over App,D: if QuoteConfirmed fails: releaseTrucks → TrucksReleased
```

Cancel runs the other way round: `cancelQuote` first (the 7-day rule lives in
the quote), then `releaseTrucks`. If the release fails it is retried; a stuck
reservation makes a truck look busy, which is safe, and releasing is
idempotent because the day refuses to release what the quote does not hold.

**Expected version is required here from day one.** Two customers reserving the
last truck at the same moment would both fold "1 free" and both append. The
`TruckDay` invariant only holds if `append(stream, expectedSeq, events)` refuses
the second one, which then retries and gets "no trucks free". In portfolio-es
this was an open question; here it is the invariant.

## 8. Sockets and plugs

| Socket (domain) | Plugs (infrastructure) |
|---|---|
| `EventStore<E>` | `SqlEventStore`, `InMemoryEventStore` |
| `DistanceSource` | `MapsDistanceSource` (timeout, failures as `Result`), `FixedDistanceSource` (tests, offline) |
| reference data: `RateCard`, `ItemCatalog`, `Fleet` | constants for now |
| clock, ids | `main.ts` |

You do not own distances, rates or the fleet: they come in through sockets.

## 9. Read side

| Screen | Built from |
|---|---|
| Calculator page | the folded quote + `estimate` |
| Availability calendar | `TrucksReserved` / `TrucksReleased` events → free trucks per date |
| Office list | quote events → quotes by status and move date |

## 10. Compensation

| Wrong fact | Compensating event |
|---|---|
| a confirmed move the customer no longer wants | `QuoteCancelled` (rule 4) |
| trucks held for a quote that did not confirm or was cancelled | `TrucksReleased` |
| a wrong item on a draft | `ItemRemoved`, or `ItemWeightChanged` |

## 11. Hardest to fix

Overbooking. Every other mistake is a draft edit or a compensating event.
A truck promised twice is a real customer with no truck on the day. That is why
the expected-version check is in the first version, not a follow-up.

Second: the 7-day boundary. "7 days or less", in which time zone, counted from
when. An off-by-one here refuses a legal cancellation or allows an illegal one.

## 12. Questions for the lead

1. `TruckDay`, one aggregate per date: right noun, or a `Fleet` aggregate?
2. Reserve first, then confirm, with `TrucksReleased` as compensation: agree with the order?
3. Expected seq on append from day one for the day stream, even if the quote stream does not strictly need it?
4. `QuoteConfirmed` carries the total and the breakdown: is the breakdown a fact worth keeping?
5. Distance recorded on `AddressesChosen` at the time it was fetched: right, or fetch again at confirm?
6. Single truck type for now (count only), types later as a new event version?
7. Abandoned drafts: leave them, or a `QuoteExpired` event after N days?
