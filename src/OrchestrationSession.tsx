import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { planTasks } from "./ipc";
import { Terminal } from "./Terminal";

interface OrchestrationSessionProps {
  visible: boolean;
  goal: string;
  tasks: string[];
  onGoalChange: (g: string) => void;
  onTasksChange: (ts: string[]) => void;
  barSlot: HTMLElement | null;
}

type WorkerStatus = "running" | "ended";
type WorkerKind = "setup" | "task" | "adhoc";

interface Worker {
  key: string;
  label: string;
  program?: string;
  args?: string[];
  kind: WorkerKind;
  status: WorkerStatus;
}

type Phase = "compose" | "prepare" | "run";

let workerCounter = 0;
const newWorkerKey = () => `orch-${++workerCounter}`;

function setupPrompt(goal: string, tasks: string[]): string {
  const numbered = tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `Overall goal: ${goal}

Planned tasks:
${numbered}

Before any implementation, prepare THIS repository's Claude Code assets so these tasks can be executed well:
- Create or update the agents (.claude/agents/*.md), skills (.claude/skills/<name>/SKILL.md), and/or workflows (.claude/workflows/*.js) the work needs.
- If a relevant agent/skill/workflow already EXISTS, modify it to fit rather than creating a duplicate.
- Keep them minimal and specific to this goal.
When done, list exactly what you created or modified. Do NOT implement the tasks themselves yet — that happens next in separate worker sessions.`;
}

function composePrompt(goal: string, task: string): string {
  return `Overall goal: ${goal}

Your task: ${task}

Use the project's Claude agents/skills/workflows under .claude/ where helpful — they were prepared for this goal.

Work autonomously in this repository: make the changes needed for your task, then briefly summarize what you changed. Stay scoped to your task.`;
}

function shortTitle(task: string): string {
  const trimmed = task.trim();
  return trimmed.length > 24 ? trimmed.slice(0, 24) + "…" : trimmed;
}

const STEPS: { key: Phase; label: string }[] = [
  { key: "compose", label: "Compose" },
  { key: "prepare", label: "Prepare" },
  { key: "run", label: "Run" },
];

export function OrchestrationSession({
  visible,
  goal,
  tasks,
  onGoalChange,
  onTasksChange,
  barSlot,
}: OrchestrationSessionProps) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [prepared, setPrepared] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const workersRef = useRef(workers);
  workersRef.current = workers;

  const nonEmptyTasks = tasks.filter((t) => t.trim().length > 0);
  const hasTaskWorkers = workers.some((w) => w.kind === "task");
  const phase: Phase = hasTaskWorkers ? "run" : prepared ? "prepare" : "compose";

  const handlePrepare = () => {
    if (!goal.trim() || prepared) return;
    const key = newWorkerKey();
    const worker: Worker = {
      key,
      label: "Setup · assets",
      program: "claude",
      args: [setupPrompt(goal, nonEmptyTasks)],
      kind: "setup",
      status: "running",
    };
    setWorkers((prev) => [...prev, worker]);
    setActiveKey(key);
    setPrepared(true);
  };

  const handleLaunch = () => {
    if (nonEmptyTasks.length === 0 || !prepared) return;
    const newWorkers: Worker[] = nonEmptyTasks.map((task) => ({
      key: newWorkerKey(),
      label: shortTitle(task),
      program: "claude",
      args: [composePrompt(goal, task)],
      kind: "task",
      status: "running",
    }));
    setWorkers((prev) => [...prev, ...newWorkers]);
    setActiveKey(newWorkers[0].key);
  };

  const handleAddWorker = () => {
    const key = newWorkerKey();
    setWorkers((prev) => {
      const n = prev.length + 1;
      return [...prev, { key, label: `Worker ${n}`, program: "claude", kind: "adhoc", status: "running" }];
    });
    setActiveKey(key);
  };

  const markEnded = (key: string) => {
    setWorkers((prev) => prev.map((w) => (w.key === key ? { ...w, status: "ended" } : w)));
  };

  const closeWorker = (key: string) => {
    const current = workersRef.current;
    setActiveKey((cur) => {
      if (cur !== key) return cur;
      const idx = current.findIndex((w) => w.key === key);
      const remaining = current.filter((w) => w.key !== key);
      return (remaining[idx] ?? remaining[idx - 1])?.key ?? null;
    });
    setWorkers((prev) => prev.filter((w) => w.key !== key));
  };

  const handlePlan = async () => {
    if (!goal.trim() || planning) return;
    setPlanning(true);
    setPlanError(null);
    try {
      const result = await planTasks(goal);
      onTasksChange(result.length ? result : [""]);
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : "Planning failed");
    } finally {
      setPlanning(false);
    }
  };

  const updateTask = (idx: number, value: string) => {
    onTasksChange(tasks.map((t, i) => (i === idx ? value : t)));
  };

  const removeTask = (idx: number) => {
    const next = tasks.filter((_, i) => i !== idx);
    onTasksChange(next.length === 0 ? [""] : next);
  };

  const phaseIndex = STEPS.findIndex((s) => s.key === phase);

  const barContent = (
    <>
      <div className="orch__stepper">
        {STEPS.map((step, i) => (
          <span
            key={step.key}
            className={
              "orch__step" +
              (i < phaseIndex ? " orch__step--done" : "") +
              (i === phaseIndex ? " orch__step--active" : "")
            }
          >
            {i + 1}&nbsp;{step.label}
          </span>
        ))}
      </div>

      {phase === "compose" && (
        <button className="orch__primary" onClick={handlePrepare} disabled={!goal.trim()}>
          Prepare agents &amp; skills
        </button>
      )}
      {phase === "prepare" && (
        <button
          className="orch__primary"
          onClick={handleLaunch}
          disabled={nonEmptyTasks.length === 0}
        >
          Start run ({nonEmptyTasks.length})
        </button>
      )}
      {phase === "run" && <span className="orch__run-chip">Run started</span>}
    </>
  );

  return (
    <div className="orch">
      {visible && barSlot && createPortal(barContent, barSlot)}

      <div className="orch__body">
        <div className="orch__rail">
          {phase !== "run" && (
            <div className="orch__plan">
              <textarea
                className="orch__goal"
                placeholder="Overall goal…"
                value={goal}
                onChange={(e) => onGoalChange(e.target.value)}
                rows={3}
              />
              <button
                className="orch__plan-btn"
                onClick={handlePlan}
                disabled={!goal.trim() || planning}
              >
                {planning ? "Planning…" : "Plan with Claude"}
              </button>
              {planError && <div className="orch__plan-error">{planError}</div>}
              <div className="orch__tasks">
                {tasks.map((task, idx) => (
                  <div key={idx} className="orch__task-row">
                    <input
                      className="orch__task-input"
                      placeholder={`Task ${idx + 1}…`}
                      value={task}
                      onChange={(e) => updateTask(idx, e.target.value)}
                    />
                    <button
                      className="orch__task-remove"
                      onClick={() => removeTask(idx)}
                      title="Remove task"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
              <button className="orch__add" onClick={() => onTasksChange([...tasks, ""])}>
                + add task
              </button>
            </div>
          )}

          {workers.length > 0 && (
            <div className="orch__sessions">
              <div className="orch__sessions-label">Sessions</div>
              {workers.map((w) => (
                <div
                  key={w.key}
                  className={"orch__session" + (w.key === activeKey ? " orch__session--active" : "")}
                  onClick={() => setActiveKey(w.key)}
                >
                  <span
                    className={"orch__dot orch__dot--" + w.status}
                    title={w.status === "running" ? "Running" : "Ended"}
                  />
                  <span className="orch__session-label">
                    {w.kind === "setup" ? <em>{w.label}</em> : w.label}
                  </span>
                  <button
                    className="orch__session-close"
                    title="Close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeWorker(w.key);
                    }}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          <button className="orch__add-worker" onClick={handleAddWorker}>
            + add worker
          </button>
        </div>

        <div className="orch__detail">
          {workers.length === 0 ? (
            <div className="orch__empty">
              Set a goal and tasks, then Prepare to begin.
            </div>
          ) : (
            workers.map((w) => (
              <div
                key={w.key}
                style={{ position: "absolute", inset: 0, display: w.key === activeKey ? undefined : "none" }}
              >
                <Terminal
                  program={w.program}
                  args={w.args}
                  visible={visible && w.key === activeKey}
                  onExit={() => markEnded(w.key)}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
