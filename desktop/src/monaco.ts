// Centralised Monaco bootstrap.
//
// The old `import * as monaco from "monaco-editor"` pulled the full editor
// barrel: every one of Monaco's ~90 languages PLUS the TypeScript / CSS / HTML
// / JSON language services (the TypeScript service alone bundles a multi-MB
// compiler). dxtutor only needs syntax highlighting, so we load the editor
// CORE plus the Monarch contributions for the languages the app actually opens.
//
// `editor.api` exposes the typed `monaco` namespace (editor, languages, Range,
// KeyMod, KeyCode, MarkerSeverity, …); `edcore.main` is a side-effect import
// that registers ALL editor contributions (hover widget, suggest, find,
// folding, decorations, view zones, quick-access) on that same singleton — we
// need them so the glossary hover, markers, drill ghost comments and the
// visualize/debug view zones keep rendering.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/edcore.main";

// Monarch syntax contributions. These cover both the guided track languages
// and every file type the Workspace explorer maps in `langForFile`. The `cpp`
// contribution registers BOTH the "c" and "cpp" language ids.
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution"; // toml/ini/cfg
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";

// JSON has no Monarch basic-language: its language service tokenises (colours)
// in the MAIN THREAD, so highlighting works without a worker. We disable JSON
// validation so the service never spawns its (heavy) worker — we only want the
// highlighting, matching the previous single-worker behaviour but without the
// console noise and without shipping the ~360 kB json.worker bundle.
import "monaco-editor/esm/vs/language/json/monaco.contribution";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Only the generic editor worker is needed: every registered language
// highlights via a main-thread Monarch/tokens provider, not a language service.
(self as any).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

// Keep JSON highlighting but skip the worker-backed validation/completion.
(monaco.languages as any).json?.jsonDefaults?.setDiagnosticsOptions({
  validate: false,
  enableSchemaRequest: false,
});

export { monaco };
export default monaco;
