/// <reference types="vite/client" />

// Monaco ships its ESM internals (edcore.main, basic-language and language
// `*.contribution` modules) as plain `.js` without declaration files. We import
// these only for their registration side effects, so an ambient `any` module
// declaration is enough. The real `editor.api` keeps its own `.d.ts`, which TS
// resolves ahead of this wildcard.
declare module "monaco-editor/esm/vs/editor/edcore.main";
declare module "monaco-editor/esm/vs/basic-languages/*";
declare module "monaco-editor/esm/vs/language/*";
