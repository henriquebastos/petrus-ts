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
