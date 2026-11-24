// 공개 업로드 경로에서 받은 이미지를 믿지 않고 다시 만든다: 매직바이트 확인 → 디코드 → 크기 제한 → 재인코드.
import sharp from 'sharp';

const MAX_INPUT_BYTES = 6 * 1024 * 1024;
const MAX_PIXELS = 24_000_000; // 예: 4K 화면 8.3M 에 여유
const MAX_SIDE = 8192;

interface ProcessedCapture {
  full: Buffer; // webp
  thumb: Buffer; // jpeg — 엑셀은 webp 를 못 쓴다
}

export class ImageError extends Error {}

function sniff(buf: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** "data:image/webp;base64,...." 를 Buffer 로 */
export function decodeDataUrl(input: string): Buffer {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(input);
  if (!m) throw new ImageError('지원하지 않는 이미지 형식입니다');
  return Buffer.from(m[2]!, 'base64');
}

export async function processCapture(input: Buffer): Promise<ProcessedCapture> {
  if (input.length > MAX_INPUT_BYTES) throw new ImageError('이미지가 너무 큽니다');
  if (!sniff(input)) throw new ImageError('이미지 형식을 확인할 수 없습니다');

  const base = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
  const meta = await base.metadata().catch(() => { throw new ImageError('이미지를 읽을 수 없습니다'); });
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h || w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) throw new ImageError('이미지 크기가 허용 범위를 넘습니다');

  // rotate() 로 EXIF 방향을 반영하고 메타데이터는 버린다.
  const full = await sharp(input, { limitInputPixels: MAX_PIXELS }).rotate().webp({ quality: 82 }).toBuffer();
  const thumb = await sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({ width: 520, withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
  return { full, thumb };
}
