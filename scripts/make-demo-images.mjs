// 데모 스테이징용 이미지를 sharp로 생성한다 (외부 다운로드 없이 결정적으로).
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const jobs = [
  ['demo/site/img/hero.jpg', 1600, 700, ['#0f3d3e', '#2a9d8f']],
  ['demo/site/img/service-1.jpg', 640, 420, ['#264653', '#e9c46a']],
  ['demo/site/img/service-2.jpg', 640, 420, ['#6d597a', '#e56b6f']],
  ['demo/site/img/service-3.jpg', 640, 420, ['#355070', '#b56576']],
  ['demo/cdn/cors/work-1.jpg', 640, 420, ['#1d3557', '#a8dadc']],
  ['demo/cdn/nocors/work-2.jpg', 640, 420, ['#7f5539', '#ddb892']],
];
for (const [path, w, h, [c1, c2]] of jobs) {
  mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w * 0.75}" cy="${h * 0.3}" r="${h * 0.18}" fill="rgba(255,255,255,.35)"/>
    <text x="24" y="${h - 24}" font-size="${Math.round(h / 12)}" fill="rgba(255,255,255,.8)" font-family="sans-serif">${path.split('/').pop()}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toFile(path);
}
console.log('images ok');
