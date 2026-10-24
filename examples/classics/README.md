# Classical nets with handlers

Small nets from the literature on concurrency, run with handler transitions (see
[packages/runtime/docs/handlers.md](../../packages/runtime/docs/handlers.md)). Each one checks the handlers
against an invariant that the net is known for. The problems are from E. W. Dijkstra, "Cooperating sequential
processes" (EWD 123, 1965), and "Hierarchical ordering of sequential processes" (EWD 310, 1971) for the dining
philosophers. The nets are their usual Petri-net forms, with each piece of outside work as a handler.

Each net is a file in `src/` with its handlers over a port to the outside service. Its test in `test/` runs it
with a fake service, a fast-check scheduler that ends the work in any order, and a store that keeps every
committed state (`test/disk.ts`), so the invariant is checked at each commit.

## 1 Producer and consumer with a bounded buffer

`src/producer-consumer.ts`. A producer makes an item for each order, and a consumer uses each item. The buffer
has room for `capacity` items; each free slot is a token on `free`.

- `produce` is a handler transition that takes an order and a slot. Its work makes the item, and its variant
  `made` puts the item in `buffer`. The slot is taken from the start of the work until the item is used, so the
  work in flight counts against the capacity.
- `consume` is a handler transition that takes an item. Its work uses it, and its variant `done` puts the item in
  `used` and gives the slot back.

At every commit, `free + produce:busy + buffer + consume:busy = capacity`, and each order is in one stage:
`orders + produce:busy + buffer + consume:busy + used` is the number of orders. After a settle, and after a crash
at any commit and a settle on a new runtime, every item is used once and every slot is free.
Test: `test/producer-consumer.test.ts` "keeps the buffer bounded and each order in one stage at every commit,
under any order of work and a crash at any commit".

## 2 Mutual exclusion

`src/mutual-exclusion.ts`. Processes use a shared resource one at a time. The one token on `mutex` is the
resource token.

- `critical` is a handler transition that takes a waiting process and the resource token. Its work is the
  critical section, and its variant `left` gives the token back.

So the token is held for the whole work, and `mutex + critical:busy = 1` at every commit. The fake resource
records each time two holders are inside at once. A holder is an operation, so a second run of one operation
after a crash is the same holder. Test: `test/mutual-exclusion.test.ts` "never has two holders inside, under any
order of work and a crash at any commit".

## 3 Dining philosophers

`src/dining-philosophers.ts`. Philosophers sit round a table with one fork between each two plates. Philosopher
`k` eats with fork `k` on the left and fork `k + 1` (round the table) on the right, so no two neighbours may eat
at once (EWD 310). Each token on `hungry` is one meal that a philosopher still wants.

- `eat` is a handler transition that takes a hungry philosopher and both of its forks in one firing; its guard
  checks that the forks are that philosopher's. Its work is the meal, and its variant `ate` puts the philosopher
  on `fed` and gives both forks back.

So the forks are held for the whole meal, and philosophers who are not neighbours eat in the same step. At every
commit each fork is on `forks` or held by one meal on `eat:busy`, so no two neighbours eat at once. No one holds
one fork and waits for the other, so the net never stops while a philosopher is hungry. Tests:
`test/dining-philosophers.test.ts` "lets philosophers who are not neighbours eat in the same step, and gives
every fork back" and "never lets two neighbours eat at once and leaves no one hungry, under any order of meals and
a crash at any commit".

## 4 Limits

- The test crashes the store at a commit. In this net no commit lands while a process is inside, so a crash at
  a commit never stops work in progress. A real process can also die between commits, while its handler is in
  the resource. Then the next settle runs the same operation again, and the next process enters after that run
  ends. If the first run's work goes on outside after the process died, as a remote call can, two holders are
  inside at once. A resource that can outlive the process that called it needs a lease or a fence keyed by the
  operation id. No test covers this case.
- A handler has no abort. A process that never leaves holds the resource token for ever.
- A philosopher can starve. EWD 310 says that taking both forks at once leaves "a particular philosopher being
  starved to death by a conspiration of his two neighbours". If the two neighbours take turns, one of them always
  holds a fork that the philosopher between them needs. `definitionOrder` keeps no state, so it cannot hold a
  neighbour back for a philosopher who has waited long. Test: `test/dining-philosophers.test.ts` "lets a
  philosopher starve while both neighbours take turns, because definitionOrder keeps no state".
