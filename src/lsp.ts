import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
} from "vscode-jsonrpc/lib/common/api.js";
import type { MessageTransports } from "vscode-languageclient/browser.js";
import { MonacoLanguageClient } from "monaco-languageclient";
import { lspStart, lspSend, lspStop, listenLspMessage, type LspStatus } from "./ipc";

// Reader fed by the lsp-message Tauri event stream.
// Drops messages whose generation differs from the live server — same staleness
// guard as the PTY id and agent run_id.
class TauriLspReader extends AbstractMessageReader {
  private _callback: DataCallback | null = null;
  private _unlisten: (() => void) | null = null;
  private _generation: number;

  constructor(generation: number) {
    super();
    this._generation = generation;
  }

  listen(callback: DataCallback): Disposable {
    this._callback = callback;
    const p = listenLspMessage((msg) => {
      if (msg.generation !== this._generation) return;
      try {
        this._callback?.(JSON.parse(msg.payload) as Message);
      } catch {
        // malformed payload — ignore
      }
    });
    p.then((fn) => {
      this._unlisten = fn;
    }).catch(() => {});
    return {
      dispose: () => {
        this._unlisten?.();
        this._unlisten = null;
        this._callback = null;
      },
    };
  }
}

class TauriLspWriter extends AbstractMessageWriter {
  write(msg: Message): Promise<void> {
    return lspSend(JSON.stringify(msg));
  }
  end(): void {}
}

export function buildTransports(generation: number): MessageTransports {
  return {
    reader: new TauriLspReader(generation),
    writer: new TauriLspWriter(),
  };
}

let _client: MonacoLanguageClient | null = null;

export async function ensurePythonLsp(): Promise<LspStatus> {
  if (_client) return { state: "running", language: "python", generation: -1 };
  const status = await lspStart("python");
  const transports = buildTransports(status.generation);
  _client = new MonacoLanguageClient({
    name: "Python Language Server",
    clientOptions: {
      documentSelector: [{ language: "python" }],
    },
    messageTransports: transports,
  });
  await _client.start();
  return status;
}

export async function teardownLsp(): Promise<void> {
  if (!_client) return;
  try {
    await _client.stop();
  } catch {
    // best-effort stop
  }
  _client = null;
  await lspStop();
}
