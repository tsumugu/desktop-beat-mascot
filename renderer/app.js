import { Rig } from './rig.js';
import { AudioEngine } from './audio.js';

const stageEl = document.getElementById('stage');
const panel = document.getElementById('panel');
const sourceSel = document.getElementById('source');
const playBtn = document.getElementById('play');
const toggleGraphBtn = document.getElementById('toggleGraph');
const fileInput = document.getElementById('file');
const graphContainer = document.getElementById('graphContainer');
const graphCanvas = document.getElementById('debugGraph');
const gctx = graphCanvas.getContext('2d');

const rig = new Rig();
const audio = new AudioEngine();

let audioEl = null;       // mp3 用 <audio>
let playing = false;

// グラフ用
let showGraph = false;
const graphHistory = [];
const MAX_HISTORY = 400; // 約6秒分のデータ(60fps想定)
let smoothPitch = null; // ピッチの平準化用

// キャンバスサイズをコンテナに合わせる
function resizeCanvas() {
  if (showGraph) {
    const rect = graphContainer.getBoundingClientRect();
    graphCanvas.width = rect.width;
    graphCanvas.height = rect.height;
  }
}
window.addEventListener('resize', resizeCanvas);

(async function main() {
  await rig.init(stageEl);

  // 入力デバイス一覧を音源セレクトに追加（BlackHole 等が出る）
  try {
    const devices = await AudioEngine.listInputDevices();
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = 'dev:' + d.deviceId;
      opt.textContent = '🎙 ' + (d.label || 'input ' + d.deviceId.slice(0, 6));
      sourceSel.appendChild(opt);
    }
  } catch (e) {
    console.warn('デバイス列挙に失敗', e);
  }

  // 描画ループ: 音声特徴量 → リグへ
  rig.app.ticker.add(() => {
    const now = performance.now() / 1000;
    const feat = audio.tick(now);
    rig.setAudio(feat);
    
    // グラフ更新
    if (showGraph && rig.debugData) {
      let displayPitch = feat.pitch;
      // ピッチの平準化 (がたつきを抑える)
      if (feat.pitch !== null) {
        if (smoothPitch === null) smoothPitch = feat.pitch;
        else smoothPitch += (feat.pitch - smoothPitch) * 0.2;
        displayPitch = smoothPitch;
      } else {
        smoothPitch = null;
      }

      graphHistory.push({
        ...rig.debugData,
        pitch: displayPitch,
        amp: feat.level || 0,
        songMood: feat.songMood // featから直接取得して履歴に保存
      });
      if (graphHistory.length > MAX_HISTORY) graphHistory.shift();
      drawGraph();
    }
  });

  setupInteraction();
})();

// ---- 音源選択 ----
sourceSel.addEventListener('change', async () => {
  const v = sourceSel.value;
  if (v === 'file') {
    fileInput.click();
    sourceSel.value = '';
  } else if (v.startsWith('dev:')) {
    const id = v.slice(4);
    try {
      await audio.useInputDevice(id);
      playing = true;
    } catch (e) {
      console.error(e);
    }
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  loadMp3(URL.createObjectURL(file));
});

// ウィンドウへ mp3 をドラッグ&ドロップでも読み込める
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadMp3(URL.createObjectURL(f));
});

async function loadMp3(url) {
  if (audioEl) { audioEl.pause(); audioEl = null; }
  audioEl = new Audio(url);
  audioEl.loop = true;
  audioEl.crossOrigin = 'anonymous';
  await audio.useMediaElement(audioEl);
  await audioEl.play();
  playing = true;
  playBtn.textContent = '⏸';
}

playBtn.addEventListener('click', async () => {
  if (!audioEl) return;
  if (audioEl.paused) { await audio.resume(); await audioEl.play(); playBtn.textContent = '⏸'; }
  else { audioEl.pause(); playBtn.textContent = '▶︎'; }
});

document.getElementById('quit').addEventListener('click', () => window.mascot.quit());

toggleGraphBtn.addEventListener('click', () => {
  showGraph = !showGraph;
  graphContainer.style.display = showGraph ? 'block' : 'none';
  if (showGraph) {
    resizeCanvas();
    // ウインドウのサイズを下に広げてグラフを表示する
    if (window.mascot.expandWindowBy) window.mascot.expandWindowBy(160);
  } else {
    // グラフを閉じたらウインドウサイズを元に戻す
    if (window.mascot.expandWindowBy) window.mascot.expandWindowBy(-160);
  }
});

// ---- グラフ描画 ----
function drawGraph() {
  if (!showGraph || graphHistory.length === 0) return;
  const w = graphCanvas.width;
  const h = graphCanvas.height;
  gctx.clearRect(0, 0, w, h);

  const dx = w / MAX_HISTORY;
  
  // 背景線(しきい値)
  gctx.strokeStyle = 'rgba(255,255,255,0.1)';
  gctx.beginPath();
  gctx.moveTo(0, h * (1 - 0.7)); gctx.lineTo(w, h * (1 - 0.7)); // happy
  gctx.moveTo(0, h * (1 - 0.92)); gctx.lineTo(w, h * (1 - 0.92)); // excite
  gctx.stroke();

  // 描画ヘルパー
  const drawLine = (key, color, scale = 1.0) => {
    gctx.strokeStyle = color;
    gctx.lineWidth = 2;
    gctx.beginPath();
    for (let i = 0; i < graphHistory.length; i++) {
      const val = graphHistory[i][key] * scale;
      const x = i * dx;
      const y = h - (val * h);
      if (i === 0) gctx.moveTo(x, y);
      else gctx.lineTo(x, y);
    }
    gctx.stroke();
  };

  // reactionVol (水色: 瞬間的な音量)
  drawLine('reactionVol', 'rgba(0, 200, 255, 0.5)');

  // targetHype (黄色: Hypeの目標値/エネルギー比率)
  drawLine('targetHype', 'rgba(255, 200, 0, 0.6)');

  // hypeFactor (赤色: 実際の盛り上がり度)
  drawLine('hypeFactor', 'rgba(255, 50, 50, 1.0)');

  // 間奏の背景シェード (青暗い) の描画
  gctx.beginPath();
  for (let i = 0; i < graphHistory.length; i++) {
    const d = graphHistory[i];
    const x = i * dx;
    if (d.isVocal === false) {
      gctx.fillStyle = 'rgba(0, 50, 150, 0.15)';
      gctx.fillRect(x, 0, dx + 1, h);
    }
  }

  // 背景のピッチガイドライン (Cの音/ド)
  gctx.strokeStyle = 'rgba(255,255,255,0.05)';
  gctx.lineWidth = 1;
  gctx.beginPath();
  for(let n = 48; n <= 84; n += 12) {
    const y = h - ((n - 40) / 50) * h;
    gctx.moveTo(0, y);
    gctx.lineTo(w, y);
  }
  gctx.stroke();

  // 音程（ピッチ）のバー描画
  for (let i = 0; i < graphHistory.length; i++) {
    const d = graphHistory[i];
    if (!d || d.pitch === null || d.pitch === undefined) continue;
    
    const x = i * dx;
    const y = h - ((d.pitch - 40) / 50) * h;
    
    // 振幅(音量)でバーの太さを変える
    const thickness = 2 + d.amp * 25;
    
    // ボーカル判定で色を変える（赤はゲージと被るため紫に変更）
    gctx.fillStyle = d.isVocal ? `rgba(180, 80, 255, ${Math.min(1, 0.4 + d.amp * 2)})` : `rgba(100, 150, 200, 0.4)`;
    
    // バーを描画
    gctx.fillRect(x, y - thickness / 2, dx + 1.5, thickness);
  }

  // イベント記号 (カオスにならないよう上部に重ならない記号で描画)
  for (let i = 0; i < graphHistory.length; i++) {
    const d = graphHistory[i];
    const x = i * dx;
    
    // 高音域爆発 (紫の丸)
    if (d.pitchHypeBonus > 0.05) {
      const radius = d.pitchHypeBonus * 12; // 最大 7px程度
      gctx.fillStyle = 'rgba(255, 50, 255, 0.8)';
      gctx.beginPath();
      gctx.arc(x, 50, radius, 0, Math.PI * 2);
      gctx.fill();
    }
    
    if (d.keyChange) {
      // 転調検知 (白星)
      gctx.fillStyle = 'white';
      gctx.font = '16px sans-serif';
      gctx.textAlign = 'center';
      gctx.textBaseline = 'middle';
      gctx.fillText('⭐', x, 20);
    } else if (d.pitchDelta > 12) {
      // 音程の跳躍 (緑の三角)
      gctx.fillStyle = 'rgba(50, 255, 100, 0.9)';
      gctx.beginPath();
      gctx.moveTo(x, 26);
      gctx.lineTo(x - 6, 36);
      gctx.lineTo(x + 6, 36);
      gctx.fill();
    }
  }

  // 曲調（songMood）の描画（見切れないように左上に配置）
  if (graphHistory.length > 0) {
    const latest = graphHistory[graphHistory.length - 1];
    if (latest.songMood !== undefined) {
      const mood = latest.songMood;
      // ゲージの幅・配置（グラフの上部中央）
      const gw = 140;
      const gh = 8;
      const gx = w / 2 - gw / 2;
      const gy = 25;

      // テキスト表示
      gctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      gctx.font = 'bold 12px sans-serif';
      gctx.textAlign = 'center';
      gctx.textBaseline = 'bottom';
      gctx.fillText(`VIBE: ${mood < 0.5 ? 'Melodic' : 'Rhythmic'} [${Math.round(mood * 100)}%]`, w / 2, gy - 4);
      
      // ゲージの背景
      gctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      gctx.fillRect(gx, gy, gw, gh);
      
      // ゲージの中身 (青:Melodic 〜 赤:Rhythmic)
      gctx.fillStyle = `hsl(${220 - mood * 220}, 80%, 60%)`; 
      gctx.fillRect(gx, gy, gw * mood, gh);
    }
  }
}

// ---- クリックスルー & ドラッグ移動 ----
function setupInteraction() {
  let ignoring = true;
  let dragging = false;

  const overPanel = (x, y) => {
    const r = panel.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const overSprite = (x, y) => {
    const b = rig.getBounds();
    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  };

  const setIgnore = (ignore) => {
    if (ignore === ignoring) return;
    ignoring = ignore;
    window.mascot.setIgnoreMouse(ignore);
  };

  // forward:true のおかげで、クリックスルー中でも mousemove は届く
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      window.mascot.moveWindowBy(e.movementX, e.movementY);
      return;
    }
    const interactive = overPanel(e.clientX, e.clientY) || overSprite(e.clientX, e.clientY);
    setIgnore(!interactive);
  });

  window.addEventListener('mousedown', (e) => {
    // パネル操作はドラッグ移動にしない
    if (overPanel(e.clientX, e.clientY)) return;
    if (overSprite(e.clientX, e.clientY)) {
      dragging = true;
      setIgnore(false);
    }
  });
  window.addEventListener('mouseup', () => { dragging = false; });
}
