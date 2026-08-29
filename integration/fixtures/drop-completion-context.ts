import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMPLETION_TYPES = new Set([
  "background-task-completion",
  "background-task-watch",
]);

/** Test fixture that removes queued delivery messages before the provider call. */
export default function dropCompletionContext(pi: ExtensionAPI): void {
  pi.on("context", (event) => ({
    messages: event.messages.filter((message) => {
      if (!message || typeof message !== "object") {
        return true;
      }
      const customType = (message as { customType?: unknown }).customType;
      return typeof customType !== "string" || !COMPLETION_TYPES.has(customType);
    }),
  }));
}
