import { PassThrough } from 'node:stream';
import type { FastifyReply } from 'fastify';

interface Subscriber {
  change(): void;
  close(): void;
}

export class ReviewEvents {
  private readonly projects = new Map<string, Set<Subscriber>>();
  private closing = false;

  subscribe(siteId: string, subscriber: Subscriber) {
    if (this.closing) return null;
    const group = this.projects.get(siteId) ?? new Set<Subscriber>();
    this.projects.set(siteId, group);
    group.add(subscriber);
    return () => {
      group.delete(subscriber);
      if (!group.size) this.projects.delete(siteId);
    };
  }

  publish(siteId: string) {
    for (const subscriber of this.projects.get(siteId) ?? []) subscriber.change();
  }

  close() {
    this.closing = true;
    for (const group of this.projects.values()) for (const subscriber of group) subscriber.close();
  }
}

/** 스트림에는 변경 신호만 싣는다. 데이터는 기존 검수 API에서 다시 읽는다. */
export function streamReviewEvents(reply: FastifyReply, events: ReviewEvents, siteId: string, expiresAt: number, authorize: () => Promise<number>) {
  const stream = new PassThrough({ highWaterMark: 1024 });
  let closed = false;
  let checking = false;
  let queued = false;
  let changed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    unsubscribe?.();
    reply.raw.off('close', close);
    stream.end();
  }

  function send(event: 'ready' | 'change' | 'ping') {
    if (!stream.write(`data: ${event}\n\n`)) close();
  }

  function armExpiry(deadline: number) {
    clearTimeout(expiry);
    expiry = setTimeout(() => check(false), Math.min(2_147_483_647, Math.max(20, deadline - Date.now())));
  }

  function check(change: boolean) {
    if (closed) return;
    queued = true;
    changed ||= change;
    if (checking) return;
    checking = true;
    void (async () => {
      try {
        while (queued && !closed) {
          queued = false;
          const notify = changed;
          changed = false;
          const deadline = await authorize();
          if (closed) break;
          armExpiry(deadline);
          send(notify ? 'change' : 'ping');
        }
      } catch {
        close();
      } finally {
        checking = false;
      }
    })();
  }

  const unsubscribe = events.subscribe(siteId, { close, change: () => check(true) });
  if (!unsubscribe || reply.raw.destroyed) {
    close();
    return reply.code(503).send();
  }
  reply.raw.once('close', close);
  heartbeat = setInterval(() => check(false), 8_000);
  armExpiry(expiresAt);
  send('ready');
  return reply
    .header('Cache-Control', 'no-cache, no-store, no-transform')
    .header('X-Accel-Buffering', 'no')
    .type('text/event-stream; charset=utf-8')
    .send(stream);
}
