import { useEffect, useCallback, useState, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import {
  openProject,
  readDir,
  readFile,
  type DirEntry,
  type CommandError,
} from "./ipc";
import { useStore } from "./store";

interface FlatNode {
  entry: DirEntry;
  depth: number;
}

function flatten(
  root: string,
  cache: Map<string, DirEntry[]>,
  expanded: Set<string>,
): FlatNode[] {
  const nodes: FlatNode[] = [];
  function walk(dirPath: string, depth: number) {
    const entries = cache.get(dirPath) ?? [];
    for (const entry of entries) {
      nodes.push({ entry, depth });
      if (entry.is_dir && expanded.has(entry.path)) {
        walk(entry.path, depth + 1);
      }
    }
  }
  walk(root, 0);
  return nodes;
}

function FolderIcon() {
  return (
    <svg className="ti" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.75 4c0-.55.45-1 1-1h3.1l1.4 1.5h6c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1V4Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="ti" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.25h4.5L12 5.75v8a.75.75 0 0 1-.75.75h-7.5A.75.75 0 0 1 3 13.75V3a.75.75 0 0 1 .75-.75Z" />
      <path d="M8.5 2.5V6h3.25" />
    </svg>
  );
}

export function Explorer() {
  const store = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const rootKey = "";
  const nodes = store.project
    ? flatten(rootKey, store.dirCache, store.expandedDirs)
    : [];

  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 22,
    overscan: 10,
  });

  const loadDir = useCallback(
    async (dirPath: string) => {
      try {
        const entries = await readDir(dirPath);
        store.setDirCache(dirPath, entries);
        store.clearInvalidated(dirPath);
      } catch (e) {
        console.error("readDir failed", e);
      }
    },
    [store],
  );

  // Load root on project open.
  useEffect(() => {
    if (store.project) void loadDir(rootKey);
  }, [store.project, loadDir]);

  // Re-fetch dirs that were invalidated by fs events.
  useEffect(() => {
    for (const p of store.invalidatedPaths) {
      void loadDir(p);
    }
  }, [store.invalidatedPaths, loadDir]);

  const handleOpenFolder = async () => {
    const selected = await dialogOpen({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try {
      const project = await openProject(selected);
      store.setProject(project);
      store.setDirCache(rootKey, []);
    } catch (e) {
      const err = e as CommandError;
      console.error("open_project failed", err.kind, err.message);
    }
  };

  const handleNodeClick = useCallback(
    async (node: FlatNode) => {
      setSelectedPath(node.entry.path);
      if (node.entry.is_dir) {
        store.toggleDir(node.entry.path);
        if (
          !store.expandedDirs.has(node.entry.path) &&
          !store.dirCache.has(node.entry.path)
        ) {
          await loadDir(node.entry.path);
        }
      } else if (store.buffers.has(node.entry.path)) {
        store.setActiveBuffer(node.entry.path);
      } else {
        try {
          const fc = await readFile(node.entry.path);
          store.openBuffer(node.entry.path, fc.content, fc.content_hash);
        } catch (e) {
          const err = e as CommandError;
          console.error("read_file failed", err.kind, err.message);
        }
      }
    },
    [store, loadDir],
  );

  // Keyboard navigation: ↑/↓ move, →/Enter open or expand, ← collapse.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (nodes.length === 0) return;
    const found = nodes.findIndex((n) => n.entry.path === selectedPath);
    const cur = found < 0 ? 0 : found;
    const node = nodes[cur];
    const move = (to: number) => {
      const i = Math.max(0, Math.min(to, nodes.length - 1));
      setSelectedPath(nodes[i].entry.path);
      virtualizer.scrollToIndex(i);
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(cur + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(cur - 1);
        break;
      case "Enter":
        e.preventDefault();
        void handleNodeClick(node);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (node.entry.is_dir && !store.expandedDirs.has(node.entry.path)) {
          void handleNodeClick(node);
        } else {
          move(cur + 1);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (node.entry.is_dir && store.expandedDirs.has(node.entry.path)) {
          store.toggleDir(node.entry.path);
        } else {
          move(cur - 1);
        }
        break;
    }
  };

  if (!store.project) {
    return (
      <div className="explorer explorer--empty">
        <button className="explorer__open-btn" onClick={handleOpenFolder}>
          Open Folder
        </button>
      </div>
    );
  }

  return (
    <div className="explorer">
      <div className="explorer__header">
        <span className="explorer__project-name">
          {store.project.root_path.split("/").at(-1)}
        </span>
        <button
          className="explorer__open-btn explorer__open-btn--small"
          onClick={handleOpenFolder}
          title="Open different folder"
        >
          ···
        </button>
      </div>
      <div
        ref={containerRef}
        className="explorer__tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const node = nodes[vi.index];
            const isActive =
              !node.entry.is_dir && store.activeBufferPath === node.entry.path;
            const isSelected = selectedPath === node.entry.path;
            const isExpanded =
              node.entry.is_dir && store.expandedDirs.has(node.entry.path);
            return (
              <div
                key={node.entry.path}
                style={{
                  position: "absolute",
                  top: vi.start,
                  left: 0,
                  right: 0,
                  height: vi.size,
                  paddingLeft: 6 + node.depth * 12,
                }}
                className={`tree-node${isActive ? " tree-node--active" : ""}${isSelected ? " tree-node--selected" : ""}`}
                onClick={() => handleNodeClick(node)}
              >
                <span className="tree-node__chevron">
                  {node.entry.is_dir ? (isExpanded ? "▾" : "▸") : ""}
                </span>
                <span
                  className={`tree-node__icon tree-node__icon--${node.entry.is_dir ? "dir" : "file"}`}
                >
                  {node.entry.is_dir ? <FolderIcon /> : <FileIcon />}
                </span>
                <span className="tree-node__name">{node.entry.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
