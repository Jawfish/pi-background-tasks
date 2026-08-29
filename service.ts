import { MAX_OUTPUT_PREVIEW_BYTES } from "./core.ts";
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
export const MAX_SERVICE_PREVIEW_BYTES = MAX_OUTPUT_PREVIEW_BYTES;

export type BackgroundTaskWatchRequest = Readonly<CreateTaskWatchInput>;
export type BackgroundTaskWatchSnapshot = Readonly<TaskWatchSnapshot>;
export type BackgroundTaskSnapshot = Readonly<
  Omit<TaskSnapshot, "watches"> & {
    watches?: readonly BackgroundTaskWatchSnapshot[];
  }
>;
export type BackgroundTaskLogs = Readonly<
  Omit<TaskLogs, "task"> & { task: BackgroundTaskSnapshot }
>;

export interface BackgroundTaskStartRequest {
  readonly command: string;
  readonly completionPolicy?: CompletionPolicy;
  readonly cwd?: string;
  readonly name?: string;
  readonly timeoutSeconds?: number;
}

export interface BackgroundTaskLogRequest {
  readonly afterByte?: number;
  readonly maxBytes?: number;
  readonly taskId: string;
}

export interface BackgroundTaskStartedEvent {
  readonly task: BackgroundTaskSnapshot;
  readonly type: "started";
}

export interface BackgroundTaskOutputEvent {
  readonly nextByte: number;
  readonly preview: string;
  readonly previewTruncated: boolean;
  readonly startByte: number;
  readonly task: BackgroundTaskSnapshot;
  readonly type: "output-committed";
}

export interface BackgroundTaskWatchFiredEvent {
  readonly nextByte?: number;
  readonly output?: string;
  readonly startByte?: number;
  readonly task: BackgroundTaskSnapshot;
  readonly type: "watch-fired";
  readonly watch: BackgroundTaskWatchSnapshot;
}

export interface BackgroundTaskFinishedEvent {
  readonly output?: string;
  readonly outputError?: string;
  readonly outputTruncated?: boolean;
  readonly task: BackgroundTaskSnapshot;
  readonly type: "finished";
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
  list(): readonly BackgroundTaskSnapshot[];
  logs(request: BackgroundTaskLogRequest): Promise<BackgroundTaskLogs>;
  start(request: BackgroundTaskStartRequest): Promise<BackgroundTaskSnapshot>;
  status(taskIdOrPrefix?: string): readonly BackgroundTaskSnapshot[];
  stop(taskIdOrPrefix: string): BackgroundTaskSnapshot;
  subscribe(
    listener: (event: BackgroundTaskLifecycleEvent) => void
  ): () => void;
  unwatch(watchIdOrPrefix: string): BackgroundTaskWatchSnapshot;
  watch(
    taskIdOrPrefix: string,
    input: BackgroundTaskWatchRequest
  ): BackgroundTaskWatchSnapshot;
  watchStatus(
    taskIdOrPrefix?: string
  ): readonly BackgroundTaskWatchSnapshot[];
}

/** Payload a consumer emits on the discovery channel. */
export interface BackgroundTaskDiscoveryRequest {
  readonly onService: (service: BackgroundTaskService) => void;
}

/** Payload published when a session service becomes available. */
export interface BackgroundTaskServiceAnnouncement {
  readonly service: BackgroundTaskService;
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
        BACKGROUND_TASK_SERVICE_VERSION &&
      typeof (service as { isAvailable?: unknown }).isAvailable ===
        "function" &&
      typeof (service as { list?: unknown }).list === "function" &&
      typeof (service as { start?: unknown }).start === "function" &&
      typeof (service as { subscribe?: unknown }).subscribe === "function"
    );
  };
