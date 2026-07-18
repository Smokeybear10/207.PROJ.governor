import type { Response } from "express";

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]*$/i;

export type SseEvent = {
  type: string;
  [key: string]: unknown;
};

export function formatSseEvent(event: SseEvent): string {
  if (!EVENT_TYPE_PATTERN.test(event.type)) {
    throw new Error(
      "SSE event types may contain only letters, numbers, dots, and dashes."
    );
  }
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function openSse(response: Response): void {
  response.status(200);
  response.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.flushHeaders();
}

export function sendSse(response: Response, event: SseEvent): boolean {
  if (response.destroyed || response.writableEnded) {
    return false;
  }
  return response.write(formatSseEvent(event));
}

export function closeSse(response: Response): void {
  if (!response.destroyed && !response.writableEnded) {
    response.end();
  }
}
