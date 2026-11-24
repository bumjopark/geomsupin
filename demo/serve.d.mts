import type { Server } from 'node:http';
export function startDemo(opts?: {
  sitePort?: number; cdnPort?: number; cdnOrigin?: string; log?: boolean;
  preview?: { appOrigin: string; id: string };
}): { site: Server; cdnServer: Server; close: () => void };
