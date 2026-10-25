# Classical nets with handlers

Small nets from the literature on concurrency, run with handler transitions (see
[packages/runtime/docs/handlers.md](../../packages/runtime/docs/handlers.md)). Each one checks the handlers
against an invariant the net is known for. The problems are from E. W. Dijkstra, "Cooperating sequential
processes" (EWD 123, 1965), and "Hierarchical ordering of sequential processes" (EWD 310, 1971) for the dining
philosophers. The simple protocol is from K. Jensen, L. M. Kristensen and L. Wells, "Coloured Petri Nets and CPN
Tools for modelling and validation of concurrent systems" (STTT 9, 2007), section 2, with the retransmission
delay of its timed form in Fig. 14. The nets are their usual Petri-net forms, with each piece of outside work
as a handler. [docs/order-process.md](docs/order-process.md) adds a workflow net with cancellation;
[docs/scale.md](docs/scale.md) has scale runs and count budgets.

Each net is a file in `src/` with its handlers over a port to the outside service. Its test in `test/` runs it
with a fake service and a fast-check scheduler that ends the work in any order. The runtime runs on Pi Durable:
the first enqueue gives the net its first tokens, each commit steps the net until nothing fires, and each piece of
work runs as a Durable task. `test/disk.ts` keeps Durable's storage in memory, records the marking of every commit
that lands, and can kill a process at any storage commit; then a new process, with a new Harness over the same
storage, enqueues the same batch again (it adds nothing when it landed) and runs the tasks until none is left. So
the invariant is checked at each commit.

## 1 Producer and consumer with a bounded buffer

`src/producer-consumer.ts`. A producer makes an item for each order, and a consumer uses each item. The buffer
has room for `capacity` items; each free slot is a token on `free`.

- `produce` is a handler transition that takes an order and a slot. Its work makes the item, and its variant
  `made` puts the item in `buffer`. The slot is taken from the start of the work until the item is used, so the
  work in flight counts against the capacity.
- `consume` is a handler transition that takes an item. Its work uses it, and its variant `done` puts the item in
  `used` and gives the slot back.

At every commit, `free + produce:busy + buffer + consume:busy = capacity`, and each order is in one stage:
`orders + produce:busy + buffer + consume:busy + used` is the number of orders. When no task is left, also after
a crash at any commit and a run of a new process, every item is used once and every slot is free.
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
at once (EWD 310). Each token on `hungry` is one meal a philosopher still wants.

- `eat` is a handler transition that takes a hungry philosopher and both of its forks in one firing. Its
  expression input arc computes the two forks from the philosopher's seat, so a binding chooses only the
  philosopher. Its work is the meal, and its variant `ate` puts the philosopher on `fed` and gives both forks back.

So the forks are held for the whole meal, and philosophers who are not neighbours eat in the same step. At every
commit each fork is on `forks` or held by one meal on `eat:busy`, so no two neighbours eat at once. No one holds
one fork and waits for the other, so the net never stops while a philosopher is hungry. Tests:
`test/dining-philosophers.test.ts` "lets philosophers who are not neighbours eat in the same step, and gives
every fork back" and "never lets two neighbours eat at once and leaves no one hungry, under any order of meals and
a crash at any commit".

One `enabledBindings` call computes the forks once for each distinct hungry philosopher.
Test: `test/dining-philosophers.test.ts` "computes the forks once for each distinct hungry philosopher in one
enabledBindings call".

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
- `Wait` is a handler transition, the retransmission timer. It takes the sent packet from `Sent`. Its handler
  returns the result `elapsed` with a delay, so the result counts a fixed wait after `SendPacket` fired; then
  `elapsed` puts the packet back on `PacketsToSend`. This is the delay `@+Wait` on that arc in the paper's timed
  net. The wait is a Durable sleep, so it survives a crash. The paper's other delays are the time the
  handlers' work takes.

At every commit `DataReceived` is the data of the packets before `NextRec`, so the receiver gets the data once
and in order. When no task is left, also after a crash at any commit and a run of a new process, all data is
received and acknowledged, and no message or work is left. The property test moves the clock to a timer's end
at any time, also while a message is in the network. Tests: `test/simple-protocol.test.ts` "sends a lost packet
again when the wait of its timer ends, and not before" and "the receiver gets the data once and in order, under
any losses, any order of messages and timer ends, and a crash at any commit".

A rerun of a handler after a crash can send a message twice. The protocol keeps only the packet it expects, so
it allows this.

## 5 Limits

- The tests crash the storage at a commit. In mutual exclusion no commit lands while a process is inside: the
  commit that marks a task running lands before its handler enters, and the next commit is the handler's result.
  So a crash at a commit never stops work in progress there. A real process can also die between commits, while
  its handler is in the resource. Then the next Harness runs the same operation's task again, and the next process
  enters after that run ends. If the first run's work goes on outside after the process died, as a remote call can, two
  holders are inside at once. A resource that can outlive the process that called it needs a lease or a fence
  keyed by the operation id. The same holds for a meal and its forks. No test covers this case.
- The nets above declare no variant `aborted`, so aborting a task leaves its operation in flight (see
  [aborts.md](../../packages/runtime/docs/aborts.md)). A process that never leaves holds the resource token for ever.
- A philosopher can starve. EWD 310 says that taking both forks at once leaves "a particular philosopher being
  starved to death by a conspiration of his two neighbours". If the two neighbours take turns, one of them always
  holds a fork the philosopher between them needs. `definitionOrder` keeps no state, so it cannot hold a
  neighbour back for a philosopher who has waited long. Test: `test/dining-philosophers.test.ts` "lets a
  philosopher starve while both neighbours take turns, because definitionOrder keeps no state".
- A net that can fire for ever never becomes quiet. In the paper's untimed net, `SendPacket` puts the packet
  straight back on `PacketsToSend`, so it can fire in every step, and a commit throws after 1,000 steps. The timer
  lets each commit of this net end.
