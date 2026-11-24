export function servicePrefix(instance: string): string;
export function apiOrigin(host: string, port: number): string;
export function readInstallation(root: string): {
  env: Record<string, string | undefined>;
  externalDatabase: boolean;
  dedicatedCluster: boolean;
  instance: 'default' | 'http';
  prefix: string;
  pgPort: number;
  savedPgPort: string | number | undefined;
};
