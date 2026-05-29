import { open } from "@tauri-apps/plugin-dialog";
import { openProject, writeFile, agentResolveEdit, type CommandError } from "./ipc";
import type { AppStore } from "./store";

// All keyboard actions go through this one handler. The palette calls the same
// individual helpers so there is no duplication between keybindings and palette.

// Resolve the pending edit, then clear it. If the write fails we must still tell
// the agent (as "rejected"), or its tool call blocks forever waiting on us.
// Returns the accepted content on success so the editor can refresh its model.
export async function acceptPendingEdit(store: AppStore): Promise<string | null> {
  const edit = store.pendingEdit;
  if (!edit) return null;
  let written: string | null = null;
  try {
    const entry = await writeFile(edit.path, edit.new_content);
    store.reconcileBuffer(edit.path, entry.content_hash);
    written = edit.new_content;
  } catch (err) {
    store.addChatError(-1, `Accept failed, edit discarded: ${(err as CommandError).message}`);
  }
  try {
    await agentResolveEdit(edit.edit_id, written ? "accepted" : "rejected");
  } catch (err) {
    store.addChatError(-1, `Agent unblock failed: ${(err as CommandError).message}`);
  }
  store.clearPendingEdit();
  return written;
}

export async function rejectPendingEdit(store: AppStore): Promise<void> {
  const edit = store.pendingEdit;
  if (!edit) return;
  try {
    await agentResolveEdit(edit.edit_id, "rejected");
  } catch (err) {
    store.addChatError(-1, `Reject failed: ${(err as CommandError).message}`);
  }
  store.clearPendingEdit();
}

export function handleGlobalKeyDown(
  e: KeyboardEvent,
  store: AppStore,
  openPalette: () => void,
  focusChatInput: () => void,
): void {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;

  switch (e.key) {
    case "o": {
      e.preventDefault();
      void (async () => {
        const path = await open({ directory: true, multiple: false, title: "Open Project" });
        if (!path) return;
        const selected = Array.isArray(path) ? path[0] : path;
        if (!selected) return;
        try {
          const project = await openProject(selected);
          store.setProject(project);
        } catch (err) {
          store.addChatError(-1, `Open failed: ${(err as CommandError).message}`);
        }
      })();
      break;
    }

    case "s": {
      // Monaco intercepts Cmd+S inside the editor via addCommand; this handler
      // fires for saves triggered outside the editor focus (e.g., from a pane
      // that doesn't have the Monaco instance focused).
      e.preventDefault();
      void (async () => {
        const path = store.activeBufferPath;
        const buf = path ? store.buffers.get(path) : undefined;
        if (!path || !buf) return;
        try {
          const entry = await writeFile(path, buf.content);
          store.reconcileBuffer(path, entry.content_hash);
          store.pushRecentEdit(path);
        } catch (err) {
          store.addChatError(-1, `Save failed: ${(err as CommandError).message}`);
        }
      })();
      break;
    }

    case "k": {
      e.preventDefault();
      openPalette();
      break;
    }

    case "1": {
      e.preventDefault();
      store.focusPane("explorer");
      break;
    }

    case "2": {
      e.preventDefault();
      store.focusPane("editor");
      break;
    }

    case "3": {
      e.preventDefault();
      store.focusPane("terminal");
      break;
    }

    case "4": {
      e.preventDefault();
      store.focusPane("chat");
      focusChatInput();
      break;
    }

    case "Enter": {
      if (!store.pendingEdit) break;
      e.preventDefault();
      void acceptPendingEdit(store);
      break;
    }

    case "Backspace": {
      if (!store.pendingEdit) break;
      e.preventDefault();
      void rejectPendingEdit(store);
      break;
    }
  }
}
