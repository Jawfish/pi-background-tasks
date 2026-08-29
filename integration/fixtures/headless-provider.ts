import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTimeout as sleep } from "node:timers/promises";

import {
  BACKGROUND_TASK_SERVICE_CHANNEL,
  isBackgroundTaskServiceAnnouncement,
} from "../../service.ts";

const provider = fauxProvider({
  provider: "pi-background-tasks-headless-test",
  tokenSize: { max: 64, min: 64 },
});

let resolveFinished: (() => void) | undefined;
const finished = new Promise<void>((resolve) => {
  resolveFinished = resolve;
});

provider.setResponses([
  fauxAssistantMessage(
    fauxToolCall("background_task", {
      action: "start",
      command:
        process.env.PI_BG_HEADLESS_COMMAND ?? "printf headless-output",
      completionPolicy: "wake",
      name: "Headless lifecycle",
    }),
    { stopReason: "toolUse" }
  ),
  async () => {
    await Promise.race([
      finished,
      sleep(10_000, undefined, { ref: false }).then(() => {
        throw new Error("Timed out waiting for headless task completion");
      }),
    ]);
    await sleep(300);
    return fauxAssistantMessage("Waiting for the headless completion");
  },
  fauxAssistantMessage("Headless completion handled"),
]);

export default function headlessProvider(pi: ExtensionAPI): void {
  pi.events.on(BACKGROUND_TASK_SERVICE_CHANNEL, (data) => {
    if (!isBackgroundTaskServiceAnnouncement(data)) {
      return;
    }
    data.service.subscribe((event) => {
      if (event.type === "finished") {
        resolveFinished?.();
      }
    });
  });
  pi.registerProvider(provider.provider);
}
