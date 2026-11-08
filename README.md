# Moving Quote

A moving company's quote calculator. A customer starts a quote, picks the items
to move and adjusts their weights, gives pickup and delivery addresses, picks a
move date and the number of trucks. The app suggests the movers and shows a live
estimate. Confirming locks the price and books the trucks for that day. A
confirmed move can be cancelled with more than 7 days' notice.

Event-sourced, hexagonal. The plan and the diagram are in [`docs/`](docs/).

## Run

```
npm install
npm run dev        # http://localhost:3100, reloads on save
npm test
npm run typecheck
```

The maps API is faked: same two addresses, same distance, a little latency,
addresses shorter than five characters are "not found". Set `COMPANY_TZ` to
change the time zone the date rules use; it defaults to the machine's.

## Shape

```
src/
  domain/                  pure: no clock, no ids minted, no I/O, no promises
    quote.ts               Quote aggregate: events, fold, verbs, estimate
    truckDay.ts            TruckDay aggregate: one per date, the shared fleet
    eventStore.ts          sockets: EventStore<E> (write), EventFeed<E> (read)
    distanceSource.ts      socket: distances come from outside
    reference.ts           shapes of the rate card, catalogue, fleet
    time.ts                Now { at, today }, date arithmetic
    result.ts              Result<T>, Stored<E>
  commands/quotes.ts       app layer: load → verb → append at the version read;
                           confirm and cancel across the two aggregates
  projections/             read side: calculator view, calendar, office list
  storage/                 SqlEventStore, InMemoryEventStore
  maps/                    FakeMapsDistanceSource, FixedDistanceSource
  reference/constants.ts   rates, catalogue, fleet as constants
  http/app.ts              routes, zod at the edge, one reply()
  main.ts                  composition root
public/index.html          the UI
tests/                     domain, commands, store contract — no mocks
```

## The rules, and where each lives

| Rule | Lives in |
|---|---|
| A confirmed quote cannot change | `Quote`: every verb checks it is a draft |
| Confirming needs items, both addresses, a future date, trucks, enough capacity | `confirmQuote` |
| A line can be edited or removed only if it exists | `changeItemWeight`, `removeItem` |
| Cancel only with more than 7 days' notice | `cancelQuote` (exactly 7 is refused) |
| A day never books more trucks than the fleet | `TruckDay.reserveTrucks` + expected version on append |

## Decisions worth defending

- **Two aggregates.** "A day cannot book more trucks than it has" is about a day, not a quote. Never an aggregate inside an aggregate: the quote knows how many trucks it wants; the day knows who has them.
- **Expected version from day one.** `append(stream, expectedSeq, events)` refuses a stale write. The day stream retries on conflict and re-decides against the truth; that is what stops two customers taking the last truck.
- **Confirm reserves first, then locks; cancel cancels first, then releases.** A failure halfway leaves a truck held too long, never a confirmed quote without a truck. If locking fails, `TrucksReleased` compensates.
- **Values from outside are copied onto the fact.** `ItemAdded` carries the weight used, `AddressesChosen` the distance fetched, `QuoteConfirmed` the price and breakdown. Changing the catalogue, the maps answer or the rates later does not change a past quote.
- **The aggregate numbers its own lines.** `lineNo` is one more than the lines added so far: pure, deterministic, never reused, no minted id.
- **`Now { at, today }`.** Events are stamped with `at`; date rules compare against `today`, the company's calendar date. The domain never asks a clock.
- **No mocks.** Commands are tested with in-memory stores, a fixed distance and fixed reference data. Two tiny store plugs in the tests simulate another customer and another browser window.

## Known gaps

- If releasing trucks after a cancellation fails three times, the quote is cancelled and the trucks stay held. Safe, but someone has to release them; a reconciling job is the follow-up.
- Projections fold every event on each read. Fine at this size; checkpointed projections when it is not.
- Abandoned drafts stay forever.
