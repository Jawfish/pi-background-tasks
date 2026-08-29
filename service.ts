import type {
  CompletionPolicy,
  CreateTaskWatchInput,
  TaskLogs,
  TaskSnapshot,
  TaskWatchSnapshot,
} from "./core.ts";

/**
 * Stable contract other Pi extensions use to share one background task
 * manager.
 *
 * Compatibility rules for the `v1` contract:
 * - Channel names, the `version` value, and existing field meanings never
 *   change while `v1` is published.
 * - New optional request fields, response fields, and lifecycle event types may
 *   be added, so consumers must ignore unknown event types.
 * - A breaking change ships as a new `v2` channel set, published alongside
 *   `v1` for at least one minor release before `v1` is removed.
 * - The service exposes immutable snapshots only. It never exposes child
 *   processes, file handles, write streams, or Pi-internal objects.
 */
export const BACKGROUND_TASK_SERVICE_VERSION = "v1";

/** Channel a consumer emits on to request the current session service. */
export const BACKGROUND_TASK_DISCOVERY_CHANNEL =
  "pi-background-tasks:v1:discover";

/** Channel this extension publishes its current session service on. */
export const BACKGROUND_TASK_SERVICE_CHANNEL = "pi-background-tasks:v1:service";

/** Maximum bytes of committed output carried by one lifecycle event. */
export const MAX_SERVICE_PREVIEW_BYTES = 256;

export interface BackgroundTaskStartRequest {
  command: string;
  completionPolicy?: CompletionPolicy;
  cwd?: string;
  name?: string;
  timeoutSeconds?: number;
}

export interface BackgroundTaskLogRequest {
  afterByte?: number;
  maxBytes?: number;
  taskId: string;
}

export interface BackgroundTaskStartedEvent {
  task: TaskSnapshot;
  type: "started";
}

export interface BackgroundTaskOutputEvent {
  nextByte: number;
  preview: string;
  previewTruncated: boolean;
  startByte: number;
  task: TaskSnapshot;
  type: "output";
}

export interface BackgroundTaskWatchFiredEvent {
  nextByte?: number;
  output?: string;
  startByte?: number;
  task: TaskSnapshot;
  type: "watch-fired";
  watch: TaskWatchSnapshot;
}

export interface BackgroundTaskFinishedEvent {
  output?: string;
  outputError?: string;
  outputTruncated?: boolean;
  task: TaskSnapshot;
  type: "finished";
}

export type BackgroundTaskLifecycleEvent =
  | BackgroundTaskStartedEvent
  | BackgroundTaskOutputEvent
  | BackgroundTaskWatchFiredEvent
  | BackgroundTaskFinishedEvent;

/** Session-bound operations shared with other extensions. */
export interface BackgroundTaskService {
  readonly sessionId: string | undefined;
  readonly version: typeof BACKGROUND_TASK_SERVICE_VERSION;
  isAvailable(): boolean;
  list(): TaskSnapshot[];
  logs(request: BackgroundTaskLogRequest): Promise<TaskLogs>;
  start(request: BackgroundTaskStartRequest): Promise<TaskSnapshot>;
  status(taskIdOrPrefix?: string): TaskSnapshot[];
  stop(taskIdOrPrefix: string): TaskSnapshot;
  subscribe(
    listener: (event: BackgroundTaskLifecycleEvent) => void
  ): () => void;
  unwatch(watchIdOrPrefix: string): TaskWatchSnapshot;
  watch(
    taskIdOrPrefix: string,
    input: CreateTaskWatchInput
  ): TaskWatchSnapshot;
  watchStatus(taskIdOrPrefix?: string): TaskWatchSnapshot[];
}

/** Payload a consumer emits on the discovery channel. */
export interface BackgroundTaskDiscoveryRequest {
  onService: (service: BackgroundTaskService) => void;
}

/** Payload published when a session service becomes available. */
export interface BackgroundTaskServiceAnnouncement {
  service: BackgroundTaskService;
}

export const isBackgroundTaskDiscoveryRequest =
  function isBackgroundTaskDiscoveryRequest(
    value: unknown
  ): value is BackgroundTaskDiscoveryRequest {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { onService?: unknown }).onService === "function"
    );
  };

export const isBackgroundTaskServiceAnnouncement =
  function isBackgroundTaskServiceAnnouncement(
    value: unknown
  ): value is BackgroundTaskServiceAnnouncement {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const service = (value as { service?: unknown }).service;
    return (
      typeof service === "object" &&
      service !== null &&
      (service as { version?: unknown }).version ===
        BACKGROUND_TASK_SERVICE_VERSION
    );
  };
