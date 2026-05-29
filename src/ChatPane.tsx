import { useEffect, useRef, useState } from "react";
import {
  agentStart,
  agentSend,
  agentStop,
  agentStatus,
  listenAgentEvent,
  type CommandError,
} from "./ipc";
import { acceptPendingEdit, rejectPendingEdit } from "./keybindings";
import { useStore } from "./store";

interface Props {
  onRegisterFocusCb: (cb: () => void) => void;
}

export function ChatPane({ onRegisterFocusCb }: Props) {
  const store = useStore();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const agentStatusRef = useRef(store.agentStatus);
  agentStatusRef.current = store.agentStatus;

  // Register the focus callback so App/keybindings can focus the input.
  useEffect(() => {
    onRegisterFocusCb(() => textareaRef.current?.focus());
  }, [onRegisterFocusCb]);

  // Restore agent lifecycle mirror and subscribe to the event stream on mount.
  useEffect(() => {
    void agentStatus()
      .then((s) => store.setAgentStatus(s))
      .catch(() => {});

    const unlistenP = listenAgentEvent((evt) => {
      switch (evt.event) {
        case "delta":
          store.appendChatDelta(evt.run_id, evt.text);
          break;
        case "message":
          store.finalizeChatMessage(evt.run_id, evt.role, evt.text);
          break;
        case "tool":
          store.addChatActivity(
            evt.run_id,
            `${evt.name}(${JSON.stringify(evt.input)})`,
          );
          break;
        case "result":
          // result marks end of turn; nothing to render beyond what's accumulated.
          break;
        case "error":
          store.addChatError(evt.run_id, evt.message);
          break;
        case "status":
          // Merge: preserve project_id and session_id already set by agent_start;
          // only the lifecycle state transitions from the event stream.
          store.setAgentStatus({
            ...agentStatusRef.current,
            state: evt.state,
          });
          break;
        case "propose_edit":
          store.setPendingEdit({
            run_id: evt.run_id,
            edit_id: evt.edit_id,
            path: evt.path,
            new_content: evt.new_content,
          });
          store.addChatActivity(
            evt.run_id,
            `Proposed edit to ${evt.path.split("/").at(-1)}`,
          );
          break;
      }
    });

    return () => {
      void unlistenP.then((fn) => fn());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- store methods are stable

  // Auto-scroll to the latest message.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [store.chatMessages]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setSending(true);
    setInput("");

    try {
      // Start lazily on first send or when the agent is stopped.
      if (store.agentStatus.state !== "running") {
        const status = await agentStart().catch((e: CommandError) => {
          store.addChatError(-1, `Agent failed to start: ${e.message}`);
          throw e;
        });
        store.setAgentStatus(status);
      }

      await agentSend(text, store.editorContext()).catch((e: CommandError) => {
        store.addChatError(-1, `Send failed: ${e.message}`);
        throw e;
      });
    } catch {
      // Errors already pushed into chat.
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const handleStop = () => {
    void agentStop()
      .then((s) => store.setAgentStatus(s))
      .catch((e: CommandError) => {
        store.addChatError(-1, `Stop failed: ${e.message}`);
      });
  };

  return (
    <div className="chat-pane">
      <div className="chat-pane__header">
        <span className="chat-pane__title">Claude</span>
        {store.agentStatus.state === "running" && (
          <button className="chat-pane__stop" onClick={handleStop}>
            Stop
          </button>
        )}
      </div>

      <div className="chat-pane__messages">
        {store.chatMessages.map((msg, i) => (
          <div
            key={i}
            className={`chat-msg chat-msg--${msg.kind}${msg.streaming ? " chat-msg--streaming" : ""}`}
          >
            {msg.kind === "user" ? (
              <>
                <span className="chat-msg__prompt-prefix">›</span>
                <span className="chat-msg__text">{msg.text}</span>
              </>
            ) : msg.kind === "activity" ? (
              <span className="chat-msg__activity">{msg.text}</span>
            ) : (
              <span className="chat-msg__text">{msg.text}</span>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {store.pendingEdit && (
        <div className="chat-pane__pending-edit">
          <span className="chat-pane__pending-edit-path">
            Edit proposed: {store.pendingEdit.path}
          </span>
          <div className="chat-pane__pending-edit-actions">
            <button onClick={() => void acceptPendingEdit(store)}>Accept</button>
            <button onClick={() => void rejectPendingEdit(store)}>Reject</button>
          </div>
        </div>
      )}

      <div className="chat-pane__input-row">
        <div className="chat-pane__input-wrap">
          <span className="chat-pane__input-prefix">›</span>
          <textarea
            ref={textareaRef}
            className="chat-pane__textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ask claude… (enter to send, shift+enter for newline)"
            rows={3}
            disabled={sending}
          />
        </div>
      </div>
    </div>
  );
}
