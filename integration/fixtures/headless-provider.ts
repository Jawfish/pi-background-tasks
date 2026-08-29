import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTimeout as sleep } from "node:timers/promises";

const provider = fauxProvider({
  provider: "pi-background-tasks-headless-test",
  tokenSize: { max: 64, min: 64 },
});

provider.setResponses([
  fauxAssistantMessage(
    fauxToolCall("background_task", {
      action: "start",
      command:
        process.env.PI_BG_HEADLESS_COMMAND ??
        "sleep 0.05; printf headless-output",
      completionPolicy: "wake",
      name: "Headless lifecycle",
    }),
    { stopReason: "toolUse" }
  ),
  async () => {
    await sleep(220);
    return fauxAssistantMessage("Waiting for the headless completion");
  },
  fauxAssistantMessage("Headless completion handled"),
]);

export default function headlessProvider(pi: ExtensionAPI): void {
  pi.registerProvider(provider.provider);
}
