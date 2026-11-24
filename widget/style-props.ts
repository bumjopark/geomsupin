// 캡처할 때 복제본으로 복사할 CSS 속성. 라이브러리 기본값은 계산된 속성 수백 개를 노드마다 전부 읽어서
// 큰 사이트(네이버)에서 복제만 17초가 걸렸다. 화면을 그리는 데 영향을 주는 속성만 남기면 0.5초로 줄어든다.
// 속성을 빼면 화면이 달라질 수 있으니, 새 CSS 기능이 깨져 보이면 여기에 추가한다.
export const STYLE_PROPS: string[] = [
  // 박스·배치
  'display', 'position', 'top', 'left', 'right', 'bottom', 'float', 'clear', 'z-index', 'box-sizing', 'contain', 'isolation',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'overflow-x', 'overflow-y', 'overflow-clip-margin', 'visibility', 'opacity',
  // 테두리·배경·그림자
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'border-image-source', 'border-image-slice', 'border-image-width', 'border-image-outset', 'border-image-repeat',
  'border-collapse', 'border-spacing', 'empty-cells', 'caption-side', 'table-layout',
  'outline-width', 'outline-style', 'outline-color', 'outline-offset', 'box-shadow', 'box-decoration-break',
  'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'background-clip', 'background-origin', 'background-attachment', 'background-blend-mode',
  // 변형·효과
  'transform', 'transform-origin', 'transform-style', 'translate', 'rotate', 'scale', 'perspective', 'perspective-origin', 'backface-visibility',
  'filter', 'backdrop-filter', 'mix-blend-mode', 'clip-path', 'clip',
  'mask-image', 'mask-size', 'mask-position', 'mask-repeat', 'mask-mode', 'mask-composite', 'mask-clip', 'mask-origin',
  // 글자
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric', 'font-feature-settings', 'font-variation-settings', 'font-kerning', 'font-optical-sizing', 'font-size-adjust',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-align-last', 'text-indent', 'text-transform', 'text-overflow', 'text-shadow', 'text-rendering', 'text-wrap',
  'text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness', 'text-underline-offset', 'text-underline-position', 'text-emphasis-style', 'text-emphasis-color',
  'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'line-break', 'tab-size', 'vertical-align', 'writing-mode', 'text-orientation', 'direction', 'unicode-bidi',
  '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'paint-order', '-webkit-line-clamp', '-webkit-box-orient', '-webkit-box-pack', '-webkit-box-align',
  'quotes', 'content', 'counter-reset', 'counter-increment', 'list-style-type', 'list-style-position', 'list-style-image',
  // 플렉스·그리드
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order', 'gap', 'row-gap', 'column-gap',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
  'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
  'column-count', 'column-width', 'column-rule-width', 'column-rule-style', 'column-rule-color', 'column-fill', 'column-span',
  // 이미지·폼
  'object-fit', 'object-position', 'image-rendering', 'appearance', 'accent-color', 'color-scheme',
  // SVG(인라인 아이콘)
  'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity', 'lighting-color', 'shape-rendering', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'marker-start', 'marker-mid', 'marker-end', 'vector-effect',
];
