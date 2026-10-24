# Example: comment replies

A small host app on Petrus, and a reference for agents that build one. It reads GitHub webhook deliveries, turns
each into a batch of tokens, and enqueues it; the commit of the batch steps the net until nothing fires. It owes
one reply to each new comment on an opened pull request. It posts nothing: the replies stay as tokens, so the
example needs no GitHub access and no token.

```sh
node examples/comment-replies/src/main.ts /tmp/comment-replies-state examples/comment-replies/sample/*.json
```

The first argument is a directory, where Pi Durable keeps the state as JSONL files. Each line of output names a
delivery and how many binding elements its commit fired. The last line is the marking. Run the command again with
the same deliveries: the state does not change. A run that fails, for example on a bad file, stops; run it again
after the fix, and the request ids make the repeated deliveries safe.

## 1 The parts

- `src/net.ts`: the net. Colour sets are TypeBox schemas, made into a `ColourSet` with `Value.Check`. Places:
  `free` (one resource token per pull request), `comments`, `replies`. One transition, `answer`, takes a comment
  and its pull request's resource token, adds a reply and gives the token back.
- `src/deliveries.ts`: the edge. It checks the untrusted payload against a schema of only the fields it reads and
  makes a `Batch`, or says why it ignores the delivery.
- `src/host.ts`: `handleDelivery` enqueues the batch into a net instance and returns what its commit fired.
- `src/main.ts`: the composition root. It is the only file that reads the system clock and the arguments. It opens
  Durable's JSONL storage in the state directory, installs the runtime's extension in a registry, opens a Harness
  with the same clock, takes the net instance in the root conversation, handles each delivery, prints the marking
  and closes the Harness.

## 2 Choosing the request id

The request id must name the input, not the attempt to send it. The runtime adds a batch once per request id, so
two arrivals of one fact must get one id, and two facts must never share one.

- GitHub keeps the `X-GitHub-Delivery` id on a redelivery
  (<https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks>). So the delivery id is
  enough when redelivery is the only repeat.
- A poll that finds the same comment, or a second event about it, has another delivery id. So this app builds the id
  from the fact's own ids: `comment:<id>` and `pull-request:<repository id>/<number>`. A redelivery, a second
  delivery and a poll then make one batch.
  Test: `test/host.test.ts` "adds a fact once, whether it comes again as a redelivery or as a new delivery".
- An id must be unique where the app runs. A comment id is unique on GitHub, but a pull request number only in its
  repository, so the id and the token hold the repository id.
  Test: `test/host.test.ts` "keeps pull requests with one number in two repositories apart".
- The same id with other tokens is a bug in the host, and the runtime throws. So the tokens of a batch hold only
  fields of the fact that never change: ids, not names. A login can change, so the comment token holds the author's
  user id. Test: `test/host.test.ts` "names a batch by the fact's own ids, not by the delivery id, and keeps only ids in its tokens".

## 3 What the example shows

- A resource token admits one binding element per step. Two comments on one pull request are answered in two
  steps of one commit: allocation gives the token to the first comment, and the token that `answer` gives back is
  new in that step. Test: `test/host.test.ts` "answers one comment per pull request per step, because the resource token is held for the step".
- The edge ignores what it does not read: a comment on an issue, another event, a payload that does not match.
  Test: `test/host.test.ts` "ignores a comment on an issue, another event, and a payload that does not match".
- A new Harness over the same state directory, as in the next run of the command, reads what the last commit
  wrote, and the same delivery sent again adds nothing. The runtime checks the stored marking against the net. It
  does not check the log: it trusts the log that Durable stored.
  Tests: `test/jsonl-storage.test.ts` "a new Harness over the same JSONL directory reads what the last commit wrote", "the same delivery sent again on the new Harness adds nothing".
- The command above, run twice, adds nothing the second time.
  Test: `test/main.test.ts` "runs the sample deliveries, and a second run of the same deliveries adds nothing".

## 4 Limits

- A comment on a pull request whose `opened` delivery never came waits: nothing gives that pull request a token.
- A commit steps until a step fires nothing, at most 1,000 steps. This net always stops; a net that can cycle makes
  the enqueue throw and commits nothing.
- One process at a time may use the state directory.
- `src/main.ts` opens the storage with `fsync` on: Durable flushes a commit's files to the disk before it appends
  the commit's marker, so after a power loss the state holds whole commits only. Durable does not flush the marker
  before the commit returns, so a power loss can lose the last commits that it acknowledged.
- The edge does not check the webhook signature. A real app checks `X-Hub-Signature-256` before it reads the body.
