// 로컬 캡처 저장소와 서명 URL.
import { mkdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { signFile } from './security.ts';

interface StoredFile {
  stream: Readable;
  size: number;
}

export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  read(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/** 서명 주소 만들기: 저장소 종류와 무관하게 앱이 /files 로 서빙한다. */
export function signedUrl(publicUrl: string, secret: string, key: string, ttlSec: number, reviewSession?: string): string {
  // 만료 시각을 시간 구간 끝으로 올려 맞춘다. 같은 구간 안에서는 같은 주소가 나와서, 위젯·관리 화면이 주기적으로 목록을 새로 받아도
  // 썸네일 주소가 안 바뀌어 이미지를 다시 내려받거나 깜빡이지 않는다. 유효 시간은 ttl 이상(최대 ttl + 구간)이다.
  const bucket = Math.max(60, Math.min(3600, Math.floor(ttlSec / 4)));
  const exp = (Math.floor(Date.now() / 1000 / bucket) + 1) * bucket + ttlSec;
  const sig = signFile(secret, key, exp, reviewSession);
  const query = new URLSearchParams({ exp: String(exp), sig });
  if (reviewSession) query.set('session', reviewSession);
  return `${publicUrl}/files/${key.split('/').map(encodeURIComponent).join('/')}?${query}`;
}

export function newCaptureKey(kind: 'full' | 'thumb' | 'proposal', ext: string, now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `captures/${y}/${m}/${randomUUID()}-${kind}.${ext}`;
}

export class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    // 키는 서버가 만든 값이지만 경로 이탈을 한 번 더 막는다.
    const p = normalize(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('invalid key');
    return p;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, p);
  }

  async get(key: string): Promise<StoredFile | null> {
    const p = this.path(key);
    try {
      const s = await stat(p);
      return { stream: createReadStream(p), size: s.size };
    } catch {
      return null;
    }
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
