import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_TASK_DISCOVERY_CHANNEL,
  BACKGROUND_TASK_SERVICE_CHANNEL,
  BACKGROUND_TASK_SERVICE_VERSION,
  isBackgroundTaskDiscoveryRequest,
  isBackgroundTaskServiceAnnouncement,
  MAX_SERVICE_PREVIEW_BYTES,
} from "./service.ts";
import type {
  BackgroundTaskLifecycleEvent,
  BackgroundTaskService,
  BackgroundTaskSnapshot,
} from "./service.ts";

const snapshot = function snapshot(): BackgroundTaskSnapshot {
  return {
    bytesWritten: 0,
    command: "true",
    completionPolicy: "notify",
    cwd: "/tmp/project",
    id: "abc12345",
    logPath: "/tmp/abc12345.log",
    name: "Contract task",
    startedAt: 1000,
    status: "running",
  };
};

const createConsumerService = function createConsumerService(): BackgroundTaskService {
  const task = snapshot();
  return {
    isAvailable: () => true,
    list: () => [task],
    logs: () =>
      Promise.resolve({
        bytesRead: 0,
        output: "",
        task,
        text: "",
        totalBytes: 0,
        truncated: false,
      }),
    sessionId: "session-one",
    start: () => Promise.resolve(task),
    status: () => [task],
    stop: () => task,
    subscribe: () => () => {
      // A consumer only needs the unsubscribe contract.
    },
    unwatch: () => ({
      condition: "exit",
      createdAt: 1000,
      id: "watch001",
      status: "cancelled",
      taskId: task.id,
      wake: false,
    }),
    version: BACKGROUND_TASK_SERVICE_VERSION,
    watch: () => ({
      condition: "exit",
      createdAt: 1000,
      id: "watch001",
      status: "active",
      taskId: task.id,
      wake: true,
    }),
    watchStatus: () => [],
  };
};

describe("background task service contract", () => {
  test("publishes stable versioned channel names", () => {
    expect(BACKGROUND_TASK_SERVICE_VERSION).toBe("v1");
    expect(BACKGROUND_TASK_DISCOVERY_CHANNEL).toBe(
      "pi-background-tasks:v1:discover"
    );
    expect(BACKGROUND_TASK_SERVICE_CHANNEL).toBe(
      "pi-background-tasks:v1:service"
    );
    expect(MAX_SERVICE_PREVIEW_BYTES).toBe(256);
  });

  test("supports a consumer that imports only the public contract", async () => {
    const service = createConsumerService();
    const received: BackgroundTaskLifecycleEvent[] = [];
    const unsubscribe = service.subscribe((event) => {
      received.push(event);
    });

    const started = await service.start({
      command: "true",
      watch: { condition: "exit" },
    });
    const logs = await service.logs({ afterByte: 0, taskId: started.id });
    const watch = service.watch(started.id, { condition: "exit", wake: true });

    expect(service.isAvailable()).toBe(true);
    expect(service.sessionId).toBe("session-one");
    expect(started.id).toBe("abc12345");
    expect(logs.totalBytes).toBe(0);
    expect(watch.status).toBe("active");
    expect(service.unwatch(watch.id).status).toBe("cancelled");
    expect(service.status(started.id)).toHaveLength(1);
    expect(service.list()).toHaveLength(1);
    expect(service.stop(started.id).id).toBe(started.id);
    expect(service.watchStatus()).toEqual([]);
    expect(received).toEqual([]);
    expect(unsubscribe()).toBeUndefined();
  });

  test("recognizes discovery requests and service announcements", () => {
    const service = createConsumerService();

    expect(isBackgroundTaskDiscoveryRequest({ onService: () => {} })).toBe(true);
    expect(isBackgroundTaskDiscoveryRequest({ onService: "no" })).toBe(false);
    expect(isBackgroundTaskDiscoveryRequest(undefined)).toBe(false);
    expect(isBackgroundTaskServiceAnnouncement({ service })).toBe(true);
    expect(
      isBackgroundTaskServiceAnnouncement({ service: { version: "v2" } })
    ).toBe(false);
    expect(isBackgroundTaskServiceAnnouncement(null)).toBe(false);
  });
});
