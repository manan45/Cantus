import { useEffect, useRef, useCallback } from "react";
import MonacoEditor, { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { writeFile, type CommandError, type Selection } from "./ipc";
import { useStore } from "./store";
import { acceptPendingEdit, rejectPendingEdit } from "./keybindings";
import { langFromPath } from "./lang";
import { ensurePythonLsp, teardownLsp } from "./lsp";
import { defineCantusDarkTheme } from "./monacoTheme";

loader.config({ monaco });
defineCantusDarkTheme();

function TabBar() {
  const store = useStore();
  const paths = [...store.buffers.keys()];

  if (paths.length === 0) return null;

  return (
    <div className="tab-bar">
      {paths.map((p) => {
        const buf = store.buffers.get(p)!;
        const name = p.split("/").at(-1);
        const active = store.activeBufferPath === p;
        const close = (e: React.MouseEvent) => {
          e.stopPropagation();
          if (buf.dirty && !confirm(`Discard unsaved changes to ${name}?`)) return;
          store.closeBuffer(p);
        };
        return (
          <div
            key={p}
            className={`tab${active ? " tab--active" : ""}${buf.externallyChanged ? " tab--external" : ""}`}
            onClick={() => store.setActiveBuffer(p)}
            onAuxClick={(e) => e.button === 1 && close(e)}
            title={p}
          >
            <span className="tab__name">{name}</span>
            <button
              className={`tab__close${buf.dirty ? " tab__close--dirty" : ""}`}
              title="Close"
              onClick={close}
            >
              <span className="tab__close-x">×</span>
              <span className="tab__close-dot" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ProposedEditDiff({
  path,
  original,
  newContent,
}: {
  path: string;
  original: string;
  newContent: string;
}) {
  const store = useStore();

  const handleAccept = async () => {
    const written = await acceptPendingEdit(store);
    // Reflect the accepted content in the live Monaco model.
    if (written !== null) {
      const uri = monaco.Uri.parse(`file:///${path}`);
      monaco.editor.getModel(uri)?.setValue(written);
    }
  };

  return (
    <div className="proposed-diff">
      <div className="proposed-diff__header">
        <span className="proposed-diff__label">Proposed edit — {path.split("/").at(-1)}</span>
        <div className="proposed-diff__actions">
          <button className="proposed-diff__accept" onClick={() => void handleAccept()}>
            Accept
          </button>
          <button className="proposed-diff__reject" onClick={() => void rejectPendingEdit(store)}>
            Reject
          </button>
        </div>
      </div>
      <div className="proposed-diff__monaco">
        <DiffEditor
          theme="cantus-dark"
          language={langFromPath(path)}
          original={original}
          modified={newContent}
          options={{
            renderSideBySide: false,
            readOnly: true,
            fontSize: 13,
            fontFamily: '"JetBrains Mono", monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  );
}

export function EditorPane() {
  const store = useStore();
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const prevPathRef = useRef<string | null>(null);
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lspStartedRef = useRef(false);

  const activePath = store.activeBufferPath;
  const activeBuf = activePath ? store.buffers.get(activePath) : undefined;

  // Start LSP when the first Python file opens and a project is loaded.
  // Tear down when the project changes (project becomes null then re-set).
  useEffect(() => {
    if (!store.project) {
      if (lspStartedRef.current) {
        lspStartedRef.current = false;
        void teardownLsp().then(() =>
          store.setLspStatus({ state: "stopped", language: null, generation: 0 }),
        );
      }
      return;
    }
    if (lspStartedRef.current) return;
    if (activePath && langFromPath(activePath) === "python") {
      lspStartedRef.current = true;
      void ensurePythonLsp()
        .then((s) => store.setLspStatus(s))
        .catch(() => {
          lspStartedRef.current = false;
        });
    }
  }, [store.project, activePath]); // eslint-disable-line react-hooks/exhaustive-deps -- store methods stable

  const pendingEdit =
    store.pendingEdit?.path === activePath ? store.pendingEdit : null;

  useEffect(() => {
    if (!activePath || !activeBuf) return;

    if (!modelsRef.current.has(activePath)) {
      const uri = monaco.Uri.parse(`file:///${activePath}`);
      const existing = monaco.editor.getModel(uri);
      const model =
        existing ??
        monaco.editor.createModel(
          activeBuf.content,
          langFromPath(activePath),
          uri,
        );
      modelsRef.current.set(activePath, model);
    }
  }, [activePath, activeBuf]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activePath) return;
    if (prevPathRef.current === activePath) return;

    const model = modelsRef.current.get(activePath);
    if (model && editor.getModel() !== model) {
      editor.setModel(model);
    }
    prevPathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    const current = editorRef.current?.getModel() ?? null;
    for (const [path, model] of modelsRef.current) {
      if (!store.buffers.has(path) && model !== current) {
        model.dispose();
        modelsRef.current.delete(path);
      }
    }
  }, [store.buffers]);

  const handleMount = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      editorRef.current = editor;

      editor.onDidChangeModelContent(() => {
        const path = store.activeBufferPath;
        if (path) store.updateBuffer(path, editor.getModel()?.getValue() ?? "");
      });

      // Debounced selection capture — snapshot is read at send time, not streamed.
      editor.onDidChangeCursorSelection((e) => {
        if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
        selectionTimerRef.current = setTimeout(() => {
          const sel = e.selection;
          const model = editor.getModel();
          if (!model) return;
          const text = model.getValueInRange(sel);
          const snapshot: Selection = {
            start_line: sel.startLineNumber,
            start_col: sel.startColumn,
            end_line: sel.endLineNumber,
            end_col: sel.endColumn,
            text,
          };
          // An empty collapsed cursor is still useful context (line position).
          store.setActiveSelection(snapshot);
        }, 150);
      });

      // Cmd+S → save and push to recent edits.
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        async () => {
          const path = store.activeBufferPath;
          if (!path) return;
          const content = editor.getModel()?.getValue();
          if (content === undefined) return;
          try {
            const entry = await writeFile(path, content);
            store.reconcileBuffer(path, entry.content_hash);
            store.pushRecentEdit(path);
          } catch (e) {
            const err = e as CommandError;
            console.error("write_file failed", err.kind, err.message);
          }
        },
      );
    },
    [store],
  );

  if (!activeBuf) {
    return (
      <div className="editor-pane editor-pane--empty">
        <span>Open a file from the explorer</span>
      </div>
    );
  }

  if (pendingEdit) {
    const currentContent =
      modelsRef.current.get(activePath!)?.getValue() ?? activeBuf.content;
    return (
      <div className="editor-pane">
        <TabBar />
        <ProposedEditDiff
          path={pendingEdit.path}
          original={currentContent}
          newContent={pendingEdit.new_content}
        />
      </div>
    );
  }

  return (
    <div className="editor-pane">
      <TabBar />
      {activeBuf.externallyChanged && (
        <div className="editor-banner">
          File changed on disk.{" "}
          <button
            onClick={async () => {
              if (!activePath) return;
              const { readFile } = await import("./ipc");
              try {
                const fc = await readFile(activePath);
                const model = modelsRef.current.get(activePath);
                if (model) {
                  model.setValue(fc.content);
                }
                store.reconcileBuffer(activePath, fc.content_hash);
              } catch (e) {
                console.error("reload failed", e);
              }
            }}
          >
            Reload
          </button>
        </div>
      )}
      <div className="editor-pane__monaco">
        <MonacoEditor
          theme="cantus-dark"
          path={activePath ?? undefined}
          defaultValue={activeBuf.content}
          language={langFromPath(activePath ?? "")}
          options={{
            fontSize: 13,
            fontFamily: '"JetBrains Mono", monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
            smoothScrolling: true,
            cursorBlinking: "smooth",
          }}
          onMount={handleMount}
        />
      </div>
    </div>
  );
}
