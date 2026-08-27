import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const CLOSE_REQUESTED_EVENT = "tauri://close-requested";

interface CurrentWindowMetadataHost extends Window {
  readonly __TAURI_INTERNALS__?: {
    readonly metadata?: {
      readonly currentWindow?: {
        readonly label?: unknown;
      };
    };
  };
}

export interface CurrentWindowCloseRequestedEvent {
  preventDefault(): void;
}

class CurrentWindowCloseRequest implements CurrentWindowCloseRequestedEvent {
  private prevented = false;

  public preventDefault(): void {
    this.prevented = true;
  }

  public isPrevented(): boolean {
    return this.prevented;
  }
}

/**
 * The official Tauri window helper reads this same injected metadata before it
 * constructs the full Window class. InkShadow only needs three lifecycle
 * operations, so keeping this narrow adapter avoids shipping every unrelated
 * position, sizing, cursor and monitor method in that class.
 */
function currentWindowLabel(): string {
  const label = (window as CurrentWindowMetadataHost).__TAURI_INTERNALS__?.metadata?.currentWindow
    ?.label;
  if (typeof label !== "string" || label.length === 0) {
    throw new Error("当前桌面窗口标识不可用。");
  }
  return label;
}

export function closeCurrentWindow(): Promise<void> {
  return invoke("plugin:window|close", { label: currentWindowLabel() });
}

export function destroyCurrentWindow(): Promise<void> {
  return destroyWindow(currentWindowLabel());
}

export function listenCurrentWindowCloseRequested(
  handler: (event: CurrentWindowCloseRequestedEvent) => void | Promise<void>,
): Promise<UnlistenFn> {
  const label = currentWindowLabel();
  return listen(
    CLOSE_REQUESTED_EVENT,
    // Tauri's event listener accepts a void callback, while matching the
    // official Window helper requires awaiting the caller before default close.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    async () => {
      const request = new CurrentWindowCloseRequest();
      await handler(request);
      if (!request.isPrevented()) {
        await destroyWindow(label);
      }
    },
    { target: { kind: "Window", label } },
  );
}

function destroyWindow(label: string): Promise<void> {
  return invoke("plugin:window|destroy", { label });
}
