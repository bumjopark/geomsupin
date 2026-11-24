// modern-screenshot 의 cloneVideo 는 영상이 로드되지 않으면 "seeked" 이벤트를 영원히 기다려 캡처 전체가 멈춘다
// (다음·한겨레·무신사에서 재현). 기다리지 않는 버전으로 바꾼다: 현재 프레임 → 포스터 → 빈 video 순.
// 또 waitUntilLoad 는 문서의 모든 <img> 가 로드되길 기다리는데, 화면 밖 지연 로딩 이미지는 영원히 로드되지 않아
// 항상 제한 시간을 다 쓴다. 필요한 이미지는 뒤에서 어차피 내려받아 인라인하므로 기다리지 않는다.
// 가림 영역은 원본 노드를 복제하기 전에 빈 상자로 대신해 픽셀·가상 요소·이미지 주소를 복제본에 넣지 않는다.
// 패턴이 없으면(라이브러리가 바뀌면) 빌드를 실패시켜 조용히 넘어가지 않게 한다.
import { readFileSync } from 'node:fs';

const REPLACEMENT = `async function cloneVideo(video, context) {
  const ownerDocument = video.ownerDocument;
  if (ownerDocument) {
    try {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.offsetWidth > 0) {
        const canvas = ownerDocument.createElement("canvas");
        canvas.width = video.offsetWidth;
        canvas.height = video.offsetHeight;
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toDataURL();
        return cloneCanvas(canvas, context);
      }
    } catch (error) {
      context.log.warn("Failed to draw video frame", error);
    }
    if (video.poster) return createImage(video.poster, ownerDocument);
  }
  return video.cloneNode(false);
}

function cloneElement`;

export const modernScreenshotPatch = {
  name: 'patch-modern-screenshot',
  setup(build) {
    build.onLoad({ filter: /modern-screenshot[\\/]dist[\\/]index\.mjs$/ }, (args) => {
      const src = readFileSync(args.path, 'utf8');
      const re = /async function cloneVideo\(video, context\) \{[\s\S]*?\n\}\n\nfunction cloneElement/;
      if (!re.test(src)) throw new Error('modern-screenshot 의 cloneVideo 패턴을 찾지 못했습니다. scripts/esbuild-patches.mjs 를 확인하세요.');
      const re2 = /async function waitUntilLoad\(node, options\) \{[\s\S]*?\n\}\nconst uuid/;
      if (!re2.test(src)) throw new Error('modern-screenshot 의 waitUntilLoad 패턴을 찾지 못했습니다. scripts/esbuild-patches.mjs 를 확인하세요.');
      const cloneContext = '  const { ownerDocument, ownerWindow, fontFamilies, onCloneEachNode } = context;';
      if (!src.includes(cloneContext)) throw new Error('modern-screenshot의 cloneNode 패턴을 찾지 못했습니다. scripts/esbuild-patches.mjs를 확인하세요.');
      const out = src.replace(re, () => REPLACEMENT)
        .replace(re2, () => 'async function waitUntilLoad() {}\nconst uuid')
        .replace(cloneContext, `${cloneContext}
  const masked = context.createMaskedClone?.(node);
  if (masked) return masked;`);
      return { contents: out, loader: 'js' };
    });
  },
};
