import * as monaco from "monaco-editor";

export function defineCantusDarkTheme() {
  monaco.editor.defineTheme("cantus-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0e1014",
      "editorGutter.background": "#0e1014",
      "minimap.background": "#0e1014",
      "editorLineNumber.foreground": "#454b57",
      "editor.selectionBackground": "#e0855f33",

      // Diff colors. vs-dark's defaults are near-transparent and both wash out to
      // the same grey over this near-black bg, so define distinct, saturated
      // green (add) / red (remove): low-alpha full-row tint + a stronger
      // char-level highlight for the exact changed text.
      "diffEditor.insertedLineBackground": "#2ea04322",
      "diffEditor.insertedTextBackground": "#3fb95055",
      "diffEditor.removedLineBackground": "#f8514922",
      "diffEditor.removedTextBackground": "#f8514955",
      "diffEditorGutter.insertedLineBackground": "#2ea04344",
      "diffEditorGutter.removedLineBackground": "#f8514944",
      "diffEditorOverview.insertedForeground": "#2ea043cc",
      "diffEditorOverview.removedForeground": "#f85149cc",
      "diffEditor.diagonalFill": "#454b5733",
    },
  });
}
