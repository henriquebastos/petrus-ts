# 1 Deterministic PR review

This demo adopts new revisions while a review runs. It finishes every selected review, then selects the latest adopted
revision. Intermediate revisions receive no review. The reviewer is a scripted fixture, not an LLM or a code analyzer.
No credentials, network calls, GitHub publication, cancellation, or decision-model integration are required.

## 1a Run and inspect

From the repository root:

```sh
pnpm --filter @petrus/example-classics build
pnpm --filter @petrus/example-classics serve --port 5300 --strictPort
```

The existing viewer hosts three PR recordings in its example selector:

- **PR review: skip B.** B and C are adopted while A runs. Reports contain A and C.
- **PR review: C arrives first.** C's admission reserves Current before A's result settles. Reports contain A and C.
- **PR review: B selected first.** A settles and B is selected before C arrives, but B's scripted review has not
  evaluated its snapshot yet. Reports contain A, B, and C.

Select a replay position, then inspect Current, Review:busy, Memory, or Reports. Sequence 1 is A, 2 is B, and 3 is C.
The expanded net shows native start and settlement transitions. Frames represent log entries, not necessarily
committed snapshots. Logical ticks are controlled time, not measured latency.

To write only the recordings, pass an output directory:

```sh
pnpm --filter @petrus/example-pr-review record /tmp/pr-review-recordings
```

`src/snapshots.ts` contains three immutable code snapshots. A permits cross-tenant access through an OR condition.
B changes a comment. C requires both conditions. Their SHA-256 content digests identify demo snapshots, not remote
Git commits. The scripted reviewer returns a finding for A and B, and no findings for C.

## 1b The authored net

`src/net.ts` defines five places and three transitions. Each arc consumes or produces one coloured token.

| Transition | Consumes | Produces | Guard |
| --- | --- | --- | --- |
| Adopt | Commits(n), Current(c) | Current(n) | n.seq = c.seq + 1 |
| Select | Current(c), Memory(m) | Current(c), Work({c,m}) | c.seq > m.reviewedSeq |
| Review | Work(w) | Memory, Reports | true |

Revision tokens contain `{seq, sha}`. Memory contains `{reviewedSeq, findings}`. A work token carries the selected
revision and prior memory. A report contains `{seq, sha, findings}`. Selection reserves memory until review settlement.
Review never takes Current, so adoption continues while a review runs.

Adopt precedes Select in definition order. Selection fixes the review choice at reservation, not when the reviewer
evaluates the code. Priority cannot replace an already reserved selection. A report describes its selected snapshot;
it does not approve a newer head. `reviewedSeq` names the last reviewed revision, not every preceding revision.

Test: `test/review.test.ts` "records %s with the selected snapshots and replayed tokens"
covers skip-b, arrival-first, and selection-first.

## 1c Native execution and checks

`src/run.ts` opens a real Petrus runtime on Pi Durable memory storage. Adopt and Select use native pure executions.
Review uses `execution(transition, task)`. Its native sleep delays the scripted result by ten logical ticks. The host
advances the shared clock, so recording does not depend on machine speed. The runtime owns tasks and reservations.

`src/record.ts` records the expanded runtime net and rejects a replay that differs from the committed final marking.
The viewer build includes a source digest. The browser reads recordings and cannot run or edit the net.

- Adoption continues while memory is held, and the next selected revision receives prior findings.
  Test: `test/review.test.ts` "holds review memory while adoption continues and carries findings across skipped revisions".
- A completed revision is not reviewed again. Repeated admission adds no tokens or occurrences.
  Test: `test/review.test.ts` "reviews one revision once and treats repeated admission as the same fact".
- An uncaught review error leaves its binding held without a report. Adoption continues, but another review cannot start.
  Test: `test/review.test.ts` "a review fault retains memory without stopping adoption or inventing a report".

## 1d Limits

One fresh instance represents one PR. Ordered observations use consecutive admission numbers, not Git ancestry.
The demo has a 1,000-start ceiling and in-memory storage. It does not demonstrate restart recovery or operator resolution.
A live model, durable host storage, webhook reconciliation, and publication remain outside this deterministic version.
