# 1 PR review demo

This demo adopts new revisions while a review runs. It finishes every selected review, then selects the latest adopted
revision. Intermediate revisions receive no review. The default reviewer is a scripted fixture, not an LLM or a code analyzer.
The recordings need no credentials. An opt-in command uses Anthropic Claude Opus 5.5. The `petrus review` command
(section 1e) monitors a real pull request with the same net and can publish reviews. Nothing cancels reviews.

## 1a Run and inspect

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
Frames are log entries, and logical ticks are controlled time.

To write only the recordings, pass an output directory:

```sh
pnpm --filter @petrus/example-pr-review record /tmp/pr-review-recordings
```

`src/snapshots.ts` contains three immutable code snapshots. A permits cross-tenant access through an OR condition.
B changes a comment. C requires both conditions. Content digests stand in for commit ids. The scripted reviewer returns a finding for A and B, and no findings for C.

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
evaluates the code. A report describes its selected snapshot;
it does not approve a newer head.

Test: `test/review.test.ts` "records %s with the selected snapshots and replayed tokens"
covers skip-b, arrival-first, and selection-first.

## 1c Native execution and checks

`src/run.ts` opens a real Petrus runtime on Pi Durable memory storage. Adopt and Select use native pure executions.
Review uses `execution(transition, task)`. Its native sleep delays the scripted result by ten logical ticks. The host
advances the shared clock, so recording does not depend on machine speed. The runtime owns tasks and reservations.

`src/record.ts` records the expanded runtime net and rejects a replay that differs from the committed final marking.

- Adoption continues while memory is held, and the next selected revision receives prior findings.
  Test: `test/review.test.ts` "holds review memory while adoption continues and carries findings across skipped revisions".
- A completed revision is not reviewed again. Repeated admission adds no tokens or occurrences.
  Test: `test/review.test.ts` "reviews one revision once and treats repeated admission as the same fact".
- An uncaught review error leaves its binding held without a report. Adoption continues, but another review cannot start.
  Test: `test/review.test.ts` "a review fault retains memory without stopping adoption or inventing a report".

## 1d Live Opus review

Set `ANTHROPIC_API_KEY` in the host environment, then supply an output file:

```sh
pnpm --filter @petrus/example-pr-review live /tmp/pr-opus.json
```

`src/live.ts` records the A-to-C scenario with `src/opus.ts` as the reviewer. Each model request receives the selected
immutable snapshot and previous findings. The prompt specifies the access rule: only administrators in the same
tenant may read a document. TypeBox validates the JSON findings before the native task returns its result.

The model makes two paid requests, with 4,096 output tokens, a 120-second timeout and no retries. Errors, incomplete output, and invalid findings leave memory held.
The recorder rejects an unfinished run rather than writing a successful recording.
Admission and sleeps still use controlled logical time. B and C arrive during A's native sleep, before its model call.

Test: `test/opus.test.ts` "Opus reviews selected snapshots with prior findings and settles validated reports".

## 1e Review a pull request: `petrus review`

```sh
pnpm --filter @petrus/example-pr-review petrus review https://github.com/OWNER/REPO/pull/N [--publish] [--state DIR]
```

One foreground process monitors one pull request. It needs `gh` signed in and `ANTHROPIC_API_KEY` set, and never
prints either. Every GitHub call is `gh api` as the signed-in user (`src/github.ts`).

- **Polling.** Every `--interval` seconds (default 60) the host reads the pull request. When its head differs from the
  last admitted head, it admits `Commits({seq, sha, base})` under request id `head:<seq>`. The number comes from the
  log, so a restart continues it. A closed pull request ends the poll after
  work in flight finishes. A faulted task stops the process with exit code 1.
  Test: `test/host.test.ts` "observations follow the head: a return to an earlier commit is a new observation".
- **Review.** The task reads the three-dot compare of the base and the selected commit, an immutable diff, and sends
  it and the previous findings to Claude Opus 5.5 (`src/pull-reviewer.ts`). A finding is a `line` finding with a
  path, a line range and an exact suggestion, or a `design` finding. A line range outside one diff hunk becomes a design
  finding that names its location, because GitHub rejects a whole review for one such comment.
  Test: `test/publication.test.ts` "settled findings keep the commit that first reported them and turn anchors outside the diff into design findings".
- **Storage.** Durable JSONL with `fsync` in `--state`, default `.petrus/OWNER/REPO/N`.

### Publication contract

`src/host-net.ts` adds two pure transitions and one task to the demo net. Classify and Withhold each take a report
and reserve Current. Classify moves a fresh report (`r.seq = c.seq`) to Outbox. Withhold moves a stale report to
Withheld and posts nothing. Its findings already reached Memory, and the next review rechecks them.
This reservation is the publication cutoff.
Tests: `test/host.test.ts` "a report superseded before classification is withheld, and the next review rechecks its findings",
"a head adopted after classification does not withdraw the classified review".

Publish takes an Outbox report and Mode, so reviews post one at a time. It posts one `COMMENT` review with `commit_id`
set to the reviewed commit (`src/publication.ts`):

- Each line finding is a comment on its lines, with a `suggestion` block when it has a replacement.
- The body lists design findings, counts findings first reported at earlier commits, and names the `gh` user.
  A review with no findings says so.
- The body ends with the marker `<!-- petrus-review seq=S sha=SHA -->`. Before it posts, the task looks for a review by
  the same user with that marker. A crash after GitHub stored a review therefore finds it and does not post again.

Tests: `test/host.test.ts` "a fresh report posts one COMMENT review on its commit, with suggestions inline and design findings in the body",
"a restart after GitHub stored a review but the response was lost finds the review instead of posting again".

Without `--publish`, Publish prints the review and calls no review endpoint. Mode is in the `initial` batch, so a
state directory keeps its first option.
Test: `test/host.test.ts` "a dry run reads no reviews and writes nothing, and its state directory refuses --publish".

A transient GitHub failure (no response, 429, 5xx, a secondary rate limit) sleeps 60 s, then 120 s, in the task.
The model request allows two SDK retries. Other errors fault the task and hold its binding; adoption continues.
Test: `test/host.test.ts` "a failed review holds memory and publishes nothing, while new heads are still adopted".
The host has no resolve command: after a fault, continue in a new state directory.

## 1f Limits

One fresh instance represents one PR. Ordered observations use consecutive admission numbers, not Git ancestry.
The recordings have a 1,000-start ceiling and memory storage. The host restarts from its state directory, but one
process at a time may use it. Its 10,000-start ceiling covers about 2,000 heads. Neither resolves faults.
