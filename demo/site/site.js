// 데모 스테이징의 동작: 캔버스 그리기, password 칸 채우기
(function () {
  var c = document.getElementById('canvas');
  if (c && c.getContext) {
    var g = c.getContext('2d');
    var grad = g.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, '#f4a261');
    grad.addColorStop(1, '#2a9d8f');
    g.fillStyle = grad;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.font = '700 36px sans-serif';
    g.fillText('Canvas 한글 텍스트', 40, 190);
  }
  var pw = document.getElementById('pw');
  if (pw) pw.value = 'super-secret-1234';
})();
