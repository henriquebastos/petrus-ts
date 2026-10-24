# Planted defect: a cited test title that the test file does not contain

Test: `test/runtime.test.ts` "commits nothing ever, under any condition".

This citation is right and must pass: `test/runtime.test.ts` "a commit fires up to stepLimit steps".

A citation may wrap to the next line. This wrapped citation is wrong: `test/runtime.test.ts` "commits nothing when
no token is ready".

This wrapped citation is right and must pass: `test/runtime.test.ts` "a batch that enables nothing commits
its ingress and fires nothing".

A citation on a later line of a paragraph is reported on its own line. This one is right: `test/runtime.test.ts`
"a batch that enables nothing commits its ingress and fires nothing", and on the next line this one is wrong:
`test/runtime.test.ts` "fires every transition at once".

> In a block quote a citation may wrap too. This one is right and must pass: `test/runtime.test.ts` "a batch that
> enables nothing commits its ingress and fires nothing".

Code is not prose, so these two code lines do not join into a citation and must pass:

```text
`test/runtime.test.ts`
"fires nothing, ever"
```
