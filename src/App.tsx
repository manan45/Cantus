import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  appInfo,
  currentProject,
  openProject,
  listenFsChanged,
  gitStatus,
  loadHistory,
  lspStatus,
  type AppInfo,
  type CommandError,
} from "./ipc";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { StoreProvider } from "./StoreProvider";
import { useStore } from "./store";
import { Explorer } from "./Explorer";
import { EditorPane } from "./EditorPane";
import { GitPanel } from "./GitPanel";
import { DiffView } from "./DiffView";
import { StatusBar } from "./StatusBar";
import { CommandPalette } from "./CommandPalette";
import { handleGlobalKeyDown } from "./keybindings";
import { TopBar, type TopView } from "./TopBar";
import { AssetBrowser } from "./AssetBrowser";
import { SessionsView } from "./SessionsView";
import { OrchestratorView } from "./OrchestratorView";
import { TerminalTabs, type TerminalTabDef } from "./TerminalTabs";
import { ChatSessions } from "./ChatSessions";
import { ChangesStrip } from "./ChangesStrip";
import "@xterm/xterm/css/xterm.css";
import "./App.css";

function Pane({ children }: { children: React.ReactNode }) {
  return <section className="pane">{children}</section>;
}

type SidebarTab = "explorer" | "git";

let shellTabCounter = 0;
const newShellKey = () => `shell-${++shellTabCounter}`;

function ShellTerminals() {
  const [tabs, setTabs] = useState<TerminalTabDef[]>(() => [
    { key: newShellKey(), title: "Shell 1" },
  ]);
  const [activeKey, setActiveKey] = useState<string>(tabs[0].key);

  const handleAdd = () => {
    const key = newShellKey();
    const title = `Shell ${tabs.length + 1}`;
    setTabs((prev) => [...prev, { key, title }]);
    setActiveKey(key);
  };

  const handleClose = (key: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      if (activeKey === key) {
        const idx = prev.findIndex((t) => t.key === key);
        const fallback = next[idx] ?? next[idx - 1];
        if (fallback) setActiveKey(fallback.key);
      }
      return next;
    });
  };

  return (
    <TerminalTabs
      tabs={tabs}
      activeKey={activeKey}
      onSelect={setActiveKey}
      onClose={handleClose}
      onAdd={handleAdd}
      onRename={(key, title) => setTabs((prev) => prev.map((t) => t.key === key ? { ...t, title } : t))}
    />
  );
}

function Landing() {
  const store = useStore();
  const [error, setError] = useState<string | null>(null);
  const openFolder = async () => {
    const selected = await dialogOpen({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try {
      store.setProject(await openProject(selected));
    } catch (e) {
      setError((e as CommandError).message);
    }
  };
  return (
    <div className="landing">
      <img className="landing__logo" src="/cantus.svg" alt="Cantus" />
      <div className="landing__brand">Cantus</div>
      <p className="landing__tagline">A Claude-first coding environment</p>
      <button className="landing__btn" onClick={() => void openFolder()}>
        Open Folder…
      </button>
      {error && <p className="landing__error">{error}</p>}
    </div>
  );
}

function WorkspaceInner({ info }: { info: AppInfo | null }) {
  const store = useStore();
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("explorer");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [topView, setTopView] = useState<TopView>("none");
  const chatFocusCbRef = useRef<(() => void) | null>(null);

  const buffersRef = useRef(store.buffers);
  buffersRef.current = store.buffers;
  const chatActiveRef = useRef(store.chatActive);
  chatActiveRef.current = store.chatActive;
  const activeBufferRef = useRef(store.activeBufferPath);
  activeBufferRef.current = store.activeBufferPath;

  const focusChatInput = useCallback(() => {
    chatFocusCbRef.current?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      handleGlobalKeyDown(e, store, () => setPaletteOpen(true), focusChatInput);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [store, focusChatInput]);

  useEffect(() => {
    void currentProject().then((p) => {
      if (!p) return;
      store.hydrateHistory({ messages: [], summaries: [] });
      store.setProject(p);
      loadHistory()
        .then((h) => store.hydrateHistory(h))
        .catch((e: { message?: string }) => {
          store.addChatError(-1, `Failed to load history: ${e.message ?? String(e)}`);
        });
    });

    void lspStatus().then((s) => store.setLspStatus(s)).catch(() => {});

    let unlisten: (() => void) | undefined;
    void listenFsChanged((change) => {
      const parts = change.path.split("/");
      parts.pop();
      const parent = parts.join("/") || "";

      store.invalidatePath(parent);

      if (change.kind !== "removed") {
        const buf = buffersRef.current.get(change.path);
        if (buf && change.content_hash && change.content_hash !== buf.contentHash) {
          store.flagExternalChange(change.path);
        }
      }

      void gitStatus()
        .then((s) => {
          store.setGitStatus(s);
          if (change.kind === "removed") return;
          const buf = buffersRef.current.get(change.path);
          const isExternal = !buf || (!!change.content_hash && change.content_hash !== buf.contentHash);
          const tracked = s.entries.some((e) => e.path === change.path);
          if (!isExternal || !tracked) return;
          store.noteAgentChange(change.path);
          if (chatActiveRef.current && change.path !== activeBufferRef.current) {
            store.openDiff(change.path);
          }
        })
        .catch(() => {});
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- store methods are stable

  if (!store.project) {
    return <Landing />;
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar__brand">{info?.name ?? "Cantus"}</span>
        <span className="titlebar__path">
          {store.project?.root_path ?? "No project open"}
        </span>
        {info && <span className="titlebar__version">v{info.version}</span>}
      </header>

      <TopBar active={topView} onSelect={setTopView} />

      <div className="workspace-area">
        <PanelGroup direction="horizontal" className="workspace">
          <Panel defaultSize={18} minSize={12}>
            <Pane>
              <div className="sidebar-tabs">
                <button
                  className={`sidebar-tab${sidebarTab === "explorer" ? " sidebar-tab--active" : ""}`}
                  onClick={() => setSidebarTab("explorer")}
                >
                  Files
                </button>
                <button
                  className={`sidebar-tab${sidebarTab === "git" ? " sidebar-tab--active" : ""}`}
                  onClick={() => setSidebarTab("git")}
                >
                  Git
                </button>
              </div>
              <div className="sidebar-body">
                {sidebarTab === "explorer" ? <Explorer /> : <GitPanel />}
              </div>
            </Pane>
          </Panel>
          <PanelResizeHandle className="resize resize--col" />
          <Panel defaultSize={54} minSize={30}>
            <PanelGroup direction="vertical">
              <Panel defaultSize={70} minSize={20}>
                <Pane>
                  <ChangesStrip />
                  {store.diffPath ? <DiffView /> : <EditorPane />}
                </Pane>
              </Panel>
              <PanelResizeHandle className="resize resize--row" />
              <Panel defaultSize={30} minSize={10}>
                <Pane>
                  <ShellTerminals />
                </Pane>
              </Panel>
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="resize resize--col" />
          <Panel defaultSize={28} minSize={18}>
            <Pane>
              <ChatSessions />
            </Pane>
          </Panel>
        </PanelGroup>

        <div
          className="workspace-overlay"
          style={{ display: topView === "orchestrator" ? undefined : "none" }}
        >
          <OrchestratorView
            visible={topView === "orchestrator"}
            onClose={() => setTopView("none")}
          />
        </div>

        {topView !== "none" && topView !== "orchestrator" && (
          <div className="workspace-overlay">
            {topView === "sessions" ? (
              <SessionsView
                onClose={() => setTopView("none")}
                onOpen={(s) => {
                  store.setChatOpenSession(s);
                  setTopView("none");
                }}
              />
            ) : (
              <AssetBrowser
                kind={topView}
                onClose={() => setTopView("none")}
                onRun={(text) => {
                  store.setChatLaunch(text);
                  setTopView("none");
                }}
              />
            )}
          </div>
        )}
      </div>

      <StatusBar />

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          focusChatInput={focusChatInput}
        />
      )}
    </div>
  );
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void appInfo().then(setInfo);
  }, []);

  return (
    <StoreProvider>
      <WorkspaceInner info={info} />
    </StoreProvider>
  );
}
