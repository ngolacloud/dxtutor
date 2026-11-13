// Affected-test selection — the pure half of "run the tests after the dev accepts a change".
//
// "Affected" here is DELIBERATELY the narrow, deterministic definition: the tests DEFINED in
// the accepted file. A test that merely references a changed symbol belongs to the grounding
// item (CodeMap / symbol relations), not here — we never guess coverage from call graphs.
//
// This module is PURE (no DOM, no Tauri) — like `patch.ts` — so the file-match can be unit
// tested offline. The editor glue in `assistant.ts` discovers the tests (`list_tests`) and
// runs the selected ones (`run_test`).

/** One discovered test (mirrors the backend `TestItem`; `tests.ts` carries the UI-side copy). */
export interface TestItem {
  name: string;
  /** How the runner addresses it (Rust: module-qualified `tests::x`; Go/Python: the name). */
  path: string;
  /** `display_path` from discovery: relative to the project root, or absolute if outside it. */
  file: string;
  line: number;
  ignored: boolean;
  lang: string;
}

/** Resolve a `TestItem.file` (relative to `root`, or already absolute) to an absolute path —
 *  the same rule `tests.ts` uses when opening a test's location, so the match agrees with the
 *  Tests panel. */
export function resolveTestFile(file: string, root: string): string {
  const f = file.replace(/^\.\//, "");
  return f.startsWith("/") ? f : `${root.replace(/\/$/, "")}/${f}`;
}

/** The tests DEFINED in `acceptedAbs` (an absolute path), preserving discovery order. Ignored
 *  (`#[ignore]`) tests are left out — they would not run without `--ignored`, so counting them
 *  as "covering the file" would be dishonest. */
export function testsInFile(items: TestItem[], acceptedAbs: string, root: string): TestItem[] {
  return items.filter((t) => !t.ignored && resolveTestFile(t.file, root) === acceptedAbs);
}
