import { useStore } from "./store";

export function ChangesStrip() {
  const store = useStore();
  const { agentChanges } = store;

  if (agentChanges.length === 0) return null;

  const label = `Claude changed ${agentChanges.length} file${agentChanges.length === 1 ? "" : "s"}`;

  return (
    <div className="changes-strip">
      <span className="changes-strip__label">{label}</span>
      <div className="changes-strip__chips">
        {agentChanges.map((path) => {
          const name = path.split("/").at(-1) ?? path;
          const isActive = path === store.diffPath;
          return (
            <div
              key={path}
              className={`changes-strip__chip${isActive ? " changes-strip__chip--active" : ""}`}
            >
              <button
                type="button"
                className="changes-strip__chip-open"
                title={path}
                onClick={() => store.openDiff(path)}
              >
                {name}
              </button>
              <button
                type="button"
                className="changes-strip__chip-x"
                title="Dismiss"
                onClick={() => {
                  store.dismissAgentChange(path);
                  if (isActive) store.closeDiff();
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button
        className="changes-strip__clear"
        onClick={() => {
          store.clearAgentChanges();
          store.closeDiff();
        }}
      >
        Clear
      </button>
    </div>
  );
}
