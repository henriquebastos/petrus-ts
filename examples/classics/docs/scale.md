# Scale runs and count budgets

`pnpm scale` (`scripts/scale.ts`) runs the dining philosophers and the order process through the runtime on
Durable's memory storage, with handlers whose work ends at once. At size N, N philosophers each eat once, or N
orders run and the shop declines the payment of every third order. N is 2 or more: with one philosopher, fork 0 is
both forks, so nothing can eat. `SIZES` sets the sizes (default `100,300,1000`), and `WHICH` the nets:
`philosophers`, `orders` or `both` (the default). For each net and size it prints one line: the total time in ms,
the storage commits, ms per commit, the largest and the mean write in bytes, the length of the log, and the bytes of
the final net-instance state. It measures time, which depends on the machine, so `pnpm feedback` does not run it.

## Count budgets

`test/scale.test.ts` runs the same setup (`test/scale.ts`) at N = 20 and N = 40 in `pnpm feedback`, and checks
counts only. Durable batches and stores its own records, so the number of commits and the size of a write depend
on Durable. Thus the budgets bound only the growth from N to 2N, with a constant slack for Durable's records. They
fail when a count grows faster than N between N = 20 and N = 40. They do not fail when a count grows by a constant
factor. The log is the runtime's, so its length is exact.

- Storage commits grow at most linearly. Test: `test/scale.test.ts` "storage commits grow at most linearly:
  commits(2N) <= 2 commits(N) + 10, for both nets".
- The largest storage write grows at most linearly. Test: `test/scale.test.ts` "the largest storage write grows
  at most linearly: largest(2N) <= 2 largest(N) + 1,000 bytes, for both nets".
- The final log has one entry for the first batch, three for each meal, and for each order eight, or ten when it
  is cancelled. Test: `test/scale.test.ts` "the final log has 3N + 1 entries for N philosophers, and 8N + 2
  ceil(N / 3) + 1 for N orders".
- The same formulas hold for generated N from 2 to 30, including all three remainders modulo 3.
  Test: `test/scale.test.ts` "the log-length formulas hold for generated sizes from 2 to 30".

## Work per net commit

`test/scale.ts` wraps the net's guards and handler guards with counters. `test/token-key-counter.ts` counts
actual `tokenKey` calls through V8's precise coverage API. The tokens are primitive strings, so getter-based
counters would change their values or miss them. This measurement does not replace any package function.
The counters reset at each net-document publication, not at Durable's unrelated storage commits.
The first commit admits all N cases and is excluded from the work budgets.
Hash capture runs separately: `state()` validates busy tokens and calls guards, so those observer calls must not enter the budget.

The target is constant maximum work per later commit between N = 20 and N = 40, with small additive slack.
Each net has its own assertion. The indexed engine and runtime cache meet both budgets.

- Guard calls: maximum(2N) <= maximum(N) + 4. Test: `test/scale.test.ts`
  "guard calls per commit after the first stay constant from N to 2N: %s".
- Token-key calls: maximum(2N) <= maximum(N) + 16. Test: `test/scale.test.ts`
  "token-key calls per commit after the first stay constant from N to 2N: %s".
- Counter checks reject missing measurements. Test: `test/scale.test.ts`
  "the per-commit counters observe guards and token keys for both nets".

## State equality

Run `pnpm scale:state` (`scripts/check-scale-state.ts`) from the repository root. It compares the SHA-256 hashes of
`JSON.stringify(await instance.state(context))` after every net commit at N = 100 and N = 300.
The hashes preserve place order, token representation, log order and timestamps. They exclude the private record stamp.
The ordinary timing runs do not capture these hashes or read the state after each commit.
`test/scale-state-baseline.json` holds the hashes from revision `88e246b25fdde1f485eca0178085af980b36558d`.
The runs have 101 and 301 philosopher commits, and 235 and 701 order commits.

The baseline was captured in a detached worktree with unchanged package sources and the same observer in `test/scale.ts`.
The script's `--record` option requires that revision. Copy the observer and script into that worktree to reproduce it.
The four runs took about 12 seconds together, so this check stays outside `pnpm feedback`.
