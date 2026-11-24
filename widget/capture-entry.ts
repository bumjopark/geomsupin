// 해시가 붙은 캡처 번들의 진입점. 요청을 작성할 때 불러온다.
import { captureViewport } from './capture.ts';

(window as unknown as { __gpCapture: unknown }).__gpCapture = { captureViewport };
