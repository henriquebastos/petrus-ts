# Order process

`src/order-process.ts` is an order process as a workflow net, after W. M. P. van der Aalst, "The Application of
Petri Nets to Workflow Management" (Journal of Circuits, Systems and Computers 8(1), 1998). Each order is a case:
its tokens carry the order's id, which must name one case only. The net shows a parallel split and join over
handlers, a choice made by handler results, one end place, and cancellation by the host.

## 1 The net

- `Split` takes an order from `Received` and starts both sides at once: a token on `ToCheck` and one on `ToCharge`.
- `CheckStock` and `Charge` are handler transitions over the shop. Their variants are `reserved` or `missing`, and
  `charged` or `declined`. Each also declares `aborted`. Every variant puts the side's outcome on `Stocked` or
  `Billed`: `[order, true]` for a success, `[order, false]` for a refusal or an abort.
- `Ship` is the join: it takes both outcomes of one order when both are true, and puts `[order, "shipped"]` on
  `Done`.
  Both `Ship` and `Undo` declare join keys by order id, so enabling pairs only outcomes of the same order.
- `Undo` is a handler transition that takes both outcomes of one order when one of them is false. Its handler asks
  the shop to release the reservation and refund the payment, those that were made. Then `[order, "cancelled"]`
  goes on `Done`.

The host cancels an order by aborting its operations in flight (see
[aborts.md](../../../packages/runtime/docs/aborts.md)). An abort can land after the shop did the work and before
its reply counted. Then the side's variant is `aborted`, but the reservation or the payment exists. So `Undo`
asks the shop to undo both sides of the order, whatever their variants said, and the shop's undo is keyed by the
order, so a second run does nothing more.

## 2 What the tests show

Van der Aalst's Definition 7 calls a workflow net sound when, from every state that the start can reach, the end
can be reached; when the end is reached no other token is left; and no transition is dead. On the runs that they
draw, the tests check for each order that it reaches `Done` and leaves no other token. That is short of the first
two conditions, and the tests do not prove soundness.

- An order that the shop can serve ships, and one whose payment the shop declines is cancelled and undone. Test:
  `test/order-process.test.ts` "ships an order that the shop can serve, and cancels and undoes one whose payment it
  declines".
- An abort that lands after the shop did the work of one side, and before its reply counted, still undoes that
  work. Test: `test/order-process.test.ts` "an abort that lands after the shop did the work of one side, before its
  reply, still undoes that work".
- Under any refusals, any order of the shop's work and replies, cancels at times the scheduler chooses, and a
  crash at any commit: at every commit each order is at most once on `Done`. At the end each order is there once
  and no other place holds a token. A shipped order holds its reservation and its payment, and a cancelled one
  holds neither. A refused order is cancelled, and an order that nobody stopped is shipped. Test:
  `test/order-process.test.ts` "each order ends once and the shop agrees, under any refusals, any order of work,
  cancels at any time, and a crash at any commit".

The fake shop waits once before its work and once before its reply, so an abort can land after the work was done.
An `Undo` that trusts the variants, and undoes nothing when both sides report a failure, fails both tests; this was
checked by hand, with no planted defect kept.

## 3 Limits

- A cancel that comes after both sides ended is too late: the sides are no longer in flight, so the order ships
  when both succeeded. An abort that races the end of a side returns `terminal`.
- The shop's work stops at a crash in these tests, because Durable aborts each run's signal when its process
  closes. A real remote call can finish after its process died, and so after the next process's `Undo`. Then a
  cancelled order keeps a reservation or a payment. A fence keyed by the order prevents this, as for the resources
  in section 5 of [README.md](../README.md). No test covers this case.
- The shop's undo must be safe to repeat, as each handler runs at least once.
