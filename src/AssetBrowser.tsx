import { useEffect, useState } from "react";
import { listClaudeAssets, type AssetItem, type ClaudeAssets } from "./ipc";

interface AssetBrowserProps {
  kind: "skills" | "agents" | "workflows";
  onClose: () => void;
  onRun: (text: string) => void;
}

function invocationFor(kind: AssetBrowserProps["kind"], item: AssetItem): string {
  if (kind === "skills") return `/${item.name} `;
  if (kind === "agents") return `Use the ${item.name} agent to `;
  return `Run the ${item.name} workflow`;
}

export function AssetBrowser({ kind, onClose, onRun }: AssetBrowserProps) {
  const [assets, setAssets] = useState<ClaudeAssets | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listClaudeAssets()
      .then(setAssets)
      .catch((e: { message?: string }) =>
        setError(e.message ?? "Failed to load assets"),
      );
  }, []);

  const items: AssetItem[] = assets ? assets[kind] : [];

  return (
    <div className="asset-browser">
      <div className="asset-browser__header">
        <span className="asset-browser__title">
          {kind.charAt(0).toUpperCase() + kind.slice(1)}
        </span>
        <button className="asset-browser__close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="asset-browser__body">
        {error && <div className="asset-browser__error">{error}</div>}
        {!assets && !error && (
          <div className="asset-browser__loading">Loading…</div>
        )}
        {items.length === 0 && assets && !error && (
          <div className="asset-browser__empty">No {kind} found.</div>
        )}
        {items.map((item) => (
          <div key={item.path} className="asset-row">
            <div className="asset-row__info">
              <span className="asset-row__name">{item.name}</span>
              <span
                className={`asset-row__scope asset-row__scope--${item.scope}`}
              >
                {item.scope}
              </span>
              <span className="asset-row__desc">{item.description}</span>
              <span className="asset-row__path">{item.path}</span>
            </div>
            <button
              className="asset-row__run"
              onClick={() => onRun(invocationFor(kind, item))}
            >
              Run
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
