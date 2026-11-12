# Planted defect: a cited test title that the test file does not contain

Test: `test/runtime.test.ts` "commits nothing ever, under any condition".

This citation is right and must pass: `test/runtime.test.ts` "plain transitions reserve inputs before their native executions produce outputs".

A citation may wrap to the next line. This wrapped citation is wrong: `test/runtime.test.ts` "commits nothing when
no token is ready".

This wrapped citation is right and must pass: `test/runtime.test.ts` "a batch that enables nothing commits
its ingress and fires nothing".

A citation on a later line of a paragraph is reported on its own line. This one is right: `test/runtime.test.ts`
"a batch that enables nothing commits its ingress and fires nothing", and on the next line this one is wrong:
`test/runtime.test.ts` "fires every transition at once".

A citation may list more test titles. In this list the first is right and the second is wrong:
`test/runtime.test.ts` "plain transitions reserve inputs before their native executions produce outputs", "fires nothing twice". In this list the last one,
after "and", is wrong: `test/runtime.test.ts` "plain transitions reserve inputs before their native executions produce outputs", "a batch that enables nothing
commits its ingress and fires nothing" and "never commits at all".

> In a block quote a citation may wrap too. This one is right and must pass: `test/runtime.test.ts` "a batch that
> enables nothing commits its ingress and fires nothing".

Code is not prose, so these two code lines do not join into a citation and must pass:

```text
`test/runtime.test.ts`
"fires nothing, ever"
```
