export type TopView = "none" | "skills" | "agents" | "workflows" | "sessions" | "orchestrator";

interface TopBarProps {
  active: TopView;
  onSelect: (view: TopView) => void;
}

export function TopBar({ active, onSelect }: TopBarProps) {
  const toggle = (view: Exclude<TopView, "none">) =>
    onSelect(active === view ? "none" : view);

  return (
    <div className="top-bar">
      {(["skills", "agents", "workflows", "sessions", "orchestrator"] as const).map((v) => (
        <button
          key={v}
          className={`top-bar__btn${active === v ? " top-bar__btn--active" : ""}`}
          onClick={() => toggle(v)}
        >
          {v.charAt(0).toUpperCase() + v.slice(1)}
        </button>
      ))}
    </div>
  );
}
