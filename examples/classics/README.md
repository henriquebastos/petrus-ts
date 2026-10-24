# Classical nets with handlers

Small nets from the literature on concurrency, run with handler transitions (see
[packages/runtime/docs/handlers.md](../../packages/runtime/docs/handlers.md)). Each one checks the handlers
against an invariant that the net is known for. The problems are from E. W. Dijkstra, "Cooperating sequential
processes" (EWD 123, 1965), and "Hierarchical ordering of sequential processes" (EWD 310, 1971) for the dining
philosophers. The simple protocol is from K. Jensen, L. M. Kristensen and L. Wells, "Coloured Petri Nets and CPN
Tools for modelling and validation of concurrent systems" (STTT 9, 2007), section 2, with the retransmission
delay of its timed form in Fig. 14. The nets are their usual Petri-net forms, with each piece of outside work
as a handler.

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

## 4 Simple protocol

`src/simple-protocol.ts`. A sender sends numbered packets to a receiver over a network that can lose packets and
acknowledgements, and deliver them in any order. The paper's places and plain transitions keep their names;
the place `Sent` and the handler transition `Wait` are added for the timer.

- `SendPacket` sends the packet that `NextSend` names. It puts a copy on `A` and starts the timer of the packet.
- `TransmitPacket` and `TransmitAck` are handler transitions. Their work is the network, and their variants are
  `delivered` (to `B` or `D`) and `lost`. In the paper a free variable `success` makes this choice; here the
  network makes it.
- `ReceivePacket` keeps a packet only when its number is `NextRec`, and puts an acknowledgement with the number
  it expects next on `C`. `ReceiveAck` sets `NextSend` to the number of the acknowledgement.
- `Wait` is a handler transition, the retransmission timer. It takes the sent packet from `Sent` and holds it
  until its work, a wait, ends; then its variant `elapsed` puts the packet back on `PacketsToSend`. This is the
  delay `@+Wait` on that arc in the paper's timed net. The paper's other delays are the time that the handlers'
  work takes.

At every commit `DataReceived` is the data of the packets before `NextRec`, so the receiver gets the data once
and in order. After a settle, and after a crash at any commit and a settle on a new runtime, all data is
received and acknowledged, and no message or work is left. Tests: `test/simple-protocol.test.ts` "holds a sent
packet until its timer runs out, and then sends it again if the network lost it" and "the receiver gets the data
once and in order, under any losses, any order of messages and timers, and a crash at any commit".

A rerun of a handler after a crash can send a message twice. The protocol keeps only the packet it expects, so
it allows this.

## 5 Limits

- The tests crash the store at a commit. In mutual exclusion no commit lands while a process is inside, so a
  crash at a commit never stops work in progress there. A real process can also die between commits, while its
  handler is in the resource. Then the next settle runs the same operation again, and the next process enters
  after that run ends. If the first run's work goes on outside after the process died, as a remote call can, two
  holders are inside at once. A resource that can outlive the process that called it needs a lease or a fence
  keyed by the operation id. The same holds for a meal and its forks. No test covers this case.
- A handler has no abort. A process that never leaves holds the resource token for ever.
- A philosopher can starve. EWD 310 says that taking both forks at once leaves "a particular philosopher being
  starved to death by a conspiration of his two neighbours". If the two neighbours take turns, one of them always
  holds a fork that the philosopher between them needs. `definitionOrder` keeps no state, so it cannot hold a
  neighbour back for a philosopher who has waited long. Test: `test/dining-philosophers.test.ts` "lets a
  philosopher starve while both neighbours take turns, because definitionOrder keeps no state".
- The timer does not survive a crash. After a crash the wait of a sent packet starts again, so the packet is sent
  again later than planned. The protocol allows a late send.
- A net that can fire for ever never settles. In the paper's untimed net, `SendPacket` puts the packet straight
  back on `PacketsToSend`, so it can fire in every step and `settle` would not return. The timer lets this net
  settle.
