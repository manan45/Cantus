import { useCallback, useEffect, useRef, useState } from "react";
import { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { gitDiff, gitStageHunk, gitStageLines, gitDiscardHunk, gitDiscardLines } from "./ipc";
import { type GitDiff, type GitHunk, type CommandError } from "./ipc";
import { langFromPath } from "./lang";
import { useStore } from "./store";
import { defineCantusDarkTheme } from "./monacoTheme";

loader.config({ monaco });
defineCantusDarkTheme();

type ViewMode = "split" | "inline";

// Maps a modified-editor line number to { hunkIndex, lineIndices } of all
// addition lines within that hunk that fall on or before the given line.
// Returns null if the line is not inside any hunk.
function resolveLineRange(
  hunks: GitHunk[],
  fromLine: number,
  toLine: number,
): { hunkIndex: number; lineIndices: number[] } | null {
  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi];
    const indices: number[] = [];
    for (let li = 0; li < hunk.lines.length; li++) {
      const line = hunk.lines[li];
      if (
        line.origin === "addition" &&
        line.new_lineno !== null &&
        line.new_lineno >= fromLine &&
        line.new_lineno <= toLine
      ) {
        indices.push(li);
      }
    }
    if (indices.length > 0) return { hunkIndex: hi, lineIndices: indices };
  }
  return null;
}

// The modified-editor line to anchor a hunk's toolbar on. Use the first changed
// (added) line rather than hunk.new_start: new_start points at the leading
// context line, which is exactly where hideUnchangedRegions paints its centered
// "N hidden lines" fold indicator — anchoring there makes the pill collide with it.
function hunkAnchorLine(hunk: GitHunk): number {
  for (const l of hunk.lines) {
    if (l.origin === "addition" && l.new_lineno !== null) return l.new_lineno;
  }
  for (const l of hunk.lines) {
    if (l.new_lineno !== null) return l.new_lineno;
  }
  return hunk.new_start === 0 ? 1 : hunk.new_start;
}

function makeWidgetBtn(label: string, cls: string, handler: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = cls;
  btn.textContent = label;
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handler();
  });
  return btn;
}

// Per-hunk toolbar rendered as a self-positioned OverlayWidget: pinned to the
// editor's right edge (a ContentWidget would track the line's column x, drifting
// with line length). Its vertical offset tracks the hunk line and is updated on
// scroll/layout via layout().
class HunkToolbarWidget implements monaco.editor.IOverlayWidget {
  private domNode: HTMLElement;
  private id: string;
  readonly line: number;

  constructor(index: number, line: number, onStage: () => void, onDiscard: () => void) {
    this.id = `cantus.hunk-toolbar.${index}`;
    this.line = line;
    this.domNode = document.createElement("div");
    this.domNode.className = "hunk-toolbar";
    this.domNode.style.position = "absolute";
    this.domNode.style.right = "14px";
    this.domNode.style.display = "none"; // shown by layout() once positioned
    this.domNode.appendChild(makeWidgetBtn("✓ Stage", "hunk-toolbar__stage", onStage));
    this.domNode.appendChild(makeWidgetBtn("↺ Discard", "hunk-toolbar__discard", onDiscard));
  }

  getId = () => this.id;
  getDomNode = () => this.domNode;
  getPosition = () => null; // self-positioned; null tells Monaco not to place it

  // Track the hunk line vertically while staying pinned right. Hidden when the
  // line scrolls out of view.
  layout(editor: monaco.editor.ICodeEditor) {
    const pos = editor.getScrolledVisiblePosition({ lineNumber: this.line, column: 1 });
    const height = editor.getLayoutInfo().height;
    if (!pos || pos.top < 0 || pos.top > height) {
      this.domNode.style.display = "none";
      return;
    }
    this.domNode.style.top = `${pos.top}px`;
    this.domNode.style.display = "flex";
  }
}

// Content widget that floats next to the cursor offering "Stage N lines" and "Discard selected".
class StageSelectionWidget implements monaco.editor.IContentWidget {
  private domNode: HTMLElement;
  private position: monaco.editor.IContentWidgetPosition | null = null;
  readonly getId = () => "cantus.stage-selection";

  constructor(
    stageLabel: string,
    discardLabel: string,
    line: number,
    onStage: () => void,
    onDiscard: () => void,
  ) {
    this.domNode = document.createElement("div");
    this.domNode.className = "diff-gutter-float-widget";

    this.domNode.appendChild(
      makeWidgetBtn(stageLabel, "diff-gutter-stage-btn--float", onStage),
    );
    this.domNode.appendChild(
      makeWidgetBtn(discardLabel, "diff-gutter-discard-btn--float", onDiscard),
    );

    this.position = {
      position: { lineNumber: line, column: 1 },
      preference: [
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
        monaco.editor.ContentWidgetPositionPreference.BELOW,
      ],
    };
  }

  getDomNode = () => this.domNode;
  getPosition = () => this.position;
}

export function DiffView() {
  const store = useStore();
  const path = store.diffPath;
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("split");

  // Refs for Monaco integration — not state because mutations must not re-render.
  const modifiedEditorRef = useRef<monaco.editor.ICodeEditor | null>(null);
  const widgetRef = useRef<StageSelectionWidget | null>(null);
  const hunkWidgetsRef = useRef<HunkToolbarWidget[]>([]);
  const diffRef = useRef<GitDiff | null>(null);

  // Keep diffRef in sync so Monaco callbacks (which close over stale state) can
  // read the latest hunks without re-registering listeners.
  useEffect(() => { diffRef.current = diff; }, [diff]);

  const fetchDiff = useCallback((p: string) => {
    void gitDiff(p)
      .then((d) => setDiff(d))
      .catch((e: CommandError) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!path) { setDiff(null); setError(null); return; }
    setDiff(null);
    setError(null);
    fetchDiff(path);
  }, [path, fetchDiff]);

  // Refresh after a stage action: re-fetch diff, update git status, close if clean.
  const afterStage = useCallback(async (p: string) => {
    try {
      const d = await gitDiff(p);
      if (d.hunks.length === 0) {
        store.closeDiff();
      } else {
        setDiff(d);
      }
    } catch (e) {
      setError((e as CommandError).message);
    }
  }, [store]);

  // Reposition all hunk toolbars (called on scroll/layout/diff change).
  const layoutHunkToolbars = useCallback((editor: monaco.editor.ICodeEditor) => {
    for (const w of hunkWidgetsRef.current) w.layout(editor);
  }, []);

  // Place one HunkToolbarWidget per hunk on the modified editor.
  const syncHunkToolbars = useCallback(
    (editor: monaco.editor.ICodeEditor, d: GitDiff | null, p: string) => {
      for (const w of hunkWidgetsRef.current) editor.removeOverlayWidget(w);
      hunkWidgetsRef.current = [];
      if (!d) return;

      const lineCount = editor.getModel()?.getLineCount() ?? 0;
      d.hunks.forEach((hunk, hunkIndex) => {
        const line = Math.max(1, Math.min(hunkAnchorLine(hunk), lineCount || 1));
        const widget = new HunkToolbarWidget(
          hunkIndex,
          line,
          () => {
            void gitStageHunk(p, hunkIndex)
              .then((status) => { store.setGitStatus(status); return afterStage(p); })
              .catch((err: CommandError) => setError(err.message));
          },
          () => {
            if (!confirm("Discard changes in this hunk? This cannot be undone.")) return;
            void gitDiscardHunk(p, hunkIndex)
              .then((status) => { store.setGitStatus(status); return afterStage(p); })
              .catch((err: CommandError) => setError(err.message));
          },
        );
        editor.addOverlayWidget(widget);
        hunkWidgetsRef.current.push(widget);
      });
      layoutHunkToolbars(editor);
    },
    [afterStage, store, layoutHunkToolbars],
  );

  // Re-sync toolbar widgets whenever the diff changes (editor already mounted).
  useEffect(() => {
    const editor = modifiedEditorRef.current;
    if (editor && path) syncHunkToolbars(editor, diff, path);
  }, [diff, path, syncHunkToolbars]);

  // Remove the floating stage-lines widget.
  const clearWidget = useCallback(() => {
    const editor = modifiedEditorRef.current;
    if (editor && widgetRef.current) {
      editor.removeContentWidget(widgetRef.current);
      widgetRef.current = null;
    }
  }, []);

  const handleEditorMount = useCallback(
    (diffEditor: monaco.editor.IStandaloneDiffEditor) => {
      const modified = diffEditor.getModifiedEditor();
      modifiedEditorRef.current = modified;

      // onMount fires after diff state is already set (and again on each mode remount),
      // so sync toolbar widgets here — the [diff] effect alone runs before the editor
      // exists on first render.
      if (path) syncHunkToolbars(modified, diffRef.current, path);

      // Keep the right-pinned hunk toolbars tracking their lines as the editor
      // scrolls or relayouts (e.g. fold reveal, pane resize).
      modified.onDidScrollChange(() => layoutHunkToolbars(modified));
      modified.onDidLayoutChange(() => layoutHunkToolbars(modified));

      // Selection change → show floating "Stage N lines" widget.
      modified.onDidChangeCursorSelection((e) => {
        clearWidget();
        const currentDiff = diffRef.current;
        if (!currentDiff || !path) return;

        const sel = e.selection;
        const startLine = sel.startLineNumber;
        const endLine = sel.endLineNumber;
        // Only show widget for non-collapsed selections.
        if (startLine === endLine && sel.startColumn === sel.endColumn) return;

        const resolved = resolveLineRange(currentDiff.hunks, startLine, endLine);
        if (!resolved || resolved.lineIndices.length === 0) return;

        const { hunkIndex, lineIndices } = resolved;
        const lineWord = `line${resolved.lineIndices.length === 1 ? "" : "s"}`;
        const stageLabel = `Stage ${resolved.lineIndices.length} ${lineWord}`;
        const discardLabel = `Discard ${resolved.lineIndices.length} ${lineWord}`;

        const widget = new StageSelectionWidget(
          stageLabel,
          discardLabel,
          startLine,
          () => {
            clearWidget();
            void gitStageLines(path, hunkIndex, lineIndices)
              .then((status) => {
                store.setGitStatus(status);
                return afterStage(path);
              })
              .catch((err: CommandError) => setError(err.message));
          },
          () => {
            clearWidget();
            if (!confirm("Discard selected lines? This cannot be undone.")) return;
            void gitDiscardLines(path, hunkIndex, lineIndices)
              .then((status: import("./ipc").GitStatus) => {
                store.setGitStatus(status);
                return afterStage(path);
              })
              .catch((err: CommandError) => setError(err.message));
          },
        );
        widgetRef.current = widget;
        modified.addContentWidget(widget);
        modified.layoutContentWidget(widget);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, store, afterStage, clearWidget, syncHunkToolbars, layoutHunkToolbars],
  );

  // Clean up widgets when diff view closes.
  useEffect(() => {
    return () => {
      const editor = modifiedEditorRef.current;
      if (editor) {
        for (const w of hunkWidgetsRef.current) editor.removeOverlayWidget(w);
      }
      hunkWidgetsRef.current = [];
      clearWidget();
      modifiedEditorRef.current = null;
    };
  }, [clearWidget]);

  if (!path) return null;

  return (
    <div className="diff-view">
      <div className="diff-view__header">
        <span className="diff-view__path">{path}</span>
        <div className="diff-view__mode-btns">
          {(["split", "inline"] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={[
                "diff-view__mode-btn",
                mode === m ? "diff-view__mode-btn--active" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => setMode(m)}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <button className="diff-view__close" onClick={store.closeDiff}>✕</button>
      </div>

      {error && <div className="diff-view__error">{error}</div>}

      {diff?.binary && (
        <div className="diff-view__binary">Binary file — no diff available</div>
      )}

      {diff && !diff.binary && (
        <div className="diff-view__monaco">
          <DiffEditor
            key={mode}
            height="100%"
            theme="cantus-dark"
            language={langFromPath(path)}
            original={diff.old_text}
            modified={diff.new_text}
            onMount={handleEditorMount}
            options={{
              renderSideBySide: mode === "split",
              readOnly: true,
              // Collapse unchanged code to changes + context, like VS Code.
              hideUnchangedRegions: {
                enabled: true,
                contextLineCount: 3,
                minimumLineCount: 3,
                revealLineCount: 20,
              },
              renderOverviewRuler: true,
              lineNumbers: "on",
              fontSize: 13,
              fontFamily: '"JetBrains Mono", monospace',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      )}
    </div>
  );
}
