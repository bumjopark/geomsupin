// 위젯 세 파일을 만든다: w.js(작은 로더) / w-core.<해시>.js(본체) / w-capture.<해시>.js(캡처, 요청 남기기를 누를 때만 로드)
// 본체·캡처는 내용 해시가 파일명에 들어가 영구 캐시(immutable)할 수 있고, 바뀌는 건 로더(w.js)뿐이다.
// 예전 빌드의 해시 파일은 몇 개 남겨 둔다(캐시된 옛 로더가 가리켜도 같은 내용을 받게).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modernScreenshotPatch } from './esbuild-patches.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = resolve(root, process.env.DIST_DIR || 'dist', 'widget'); // 상대·절대 DIST_DIR 모두 지원
mkdirSync(out, { recursive: true });
const KEEP = 8;

const common = { bundle: true, minify: true, format: 'iife', target: 'es2020', logLevel: 'error', legalComments: 'none', charset: 'utf8' };
const [coreBuild, captureBuild] = await Promise.all([
  build({ ...common, entryPoints: [join(root, 'widget/core.ts')], write: false }),
  build({ ...common, entryPoints: [join(root, 'widget/capture-entry.ts')], write: false, plugins: [modernScreenshotPatch] }),
]);

const h = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);
const coreBuf = coreBuild.outputFiles[0].contents;
const capBuf = captureBuild.outputFiles[0].contents;
const core = `w-core.${h(coreBuf)}.js`;
const capture = `w-capture.${h(capBuf)}.js`;
writeFileSync(join(out, core), coreBuf);
writeFileSync(join(out, capture), capBuf);

await build({ ...common, entryPoints: [join(root, 'widget/loader.ts')], outfile: join(out, 'w.js'), define: { __CORE__: JSON.stringify(core), __CAPTURE__: JSON.stringify(capture) } });

// 오래된 해시 파일 정리(종류별로 최신 KEEP 개만)
for (const prefix of ['w-core.', 'w-capture.']) {
  const files = readdirSync(out).filter((f) => f.startsWith(prefix) && /\.[0-9a-f]{10}\.js$/.test(f)).map((f) => ({ f, t: statSync(join(out, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const x of files.slice(KEEP)) rmSync(join(out, x.f));
}

for (const f of ['w.js', core, capture]) {
  const buf = readFileSync(join(out, f));
  console.log(`${f.padEnd(24)} ${(statSync(join(out, f)).size / 1024).toFixed(1).padStart(6)} KB  (gzip ${(gzipSync(buf).length / 1024).toFixed(1)} KB)`);
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ core, capture, builtAt: new Date().toISOString() }) + '\n');
console.log('build', core, capture);
