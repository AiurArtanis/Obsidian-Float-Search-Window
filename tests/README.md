# Float Search regression tests

Run after installing the repository's dependencies:

```sh
node --test tests/*.test.cjs
```

These tests transpile the actual TypeScript source with the existing esbuild
dependency. The test loader adds exports for the two private modal classes only
in memory; it does not change the plugin's production exports. `monkey-around`
is the real installed dependency. Obsidian classes, DOM elements and timers are
small isolated test doubles, so no Obsidian app, vault or desktop is modified.

Coverage includes native file dispatch, heading and line destinations, new-tab
selection, empty-result preview cleanup, late content reads, preview races,
modal closure during initialization and file opens, native regex query escaping,
invalid patterns, adapter cleanup, raw-query persistence, multiline/case parity,
and file-type/bookmark filtering.

Timers and deferred promises make cancellation tests deterministic: each pending
operation is started, interrupted, and then resolved. These are behavioral unit
tests, not a replacement for testing rendered UI and Obsidian's native search
parser in a real application.

To run the same assertions against another source snapshot, set
`FLOAT_SEARCH_TEST_SOURCE_ROOT` to a directory containing
`src/floatSearchIndex.ts` and `src/filterBar.ts`. Dependencies still resolve from
this repository.
