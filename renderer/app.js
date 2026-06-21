import { Rig } from './rig.js';
import { AudioEngine } from './audio.js';

const stageEl = document.getElementById('stage');
const panel = document.getElementById('panel');
const sourceSel = document.getElementById('source');
const outputSel = document.getElementById('outputSel');
const passthroughCheckbox = document.getElementById('passthrough');
const monitorVolumeSlider = document.getElementById('monitorVolume');
const toggleGraphBtn = document.getElementById('toggleGraph');
const graphContainer = document.getElementById('graphContainer');
const graphCanvas = document.getElementById('debugGraph');
const gctx = graphCanvas.getContext('2d');

const rig = new Rig();
const audio = new AudioEngine();



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

  // 入力デバイス・出力デバイス一覧をセレクトに追加
  try {
    let targetInId = null;
    let fallbackInId = null;
    const inDevices = await AudioEngine.listInputDevices();
    for (const d of inDevices) {
      const opt = document.createElement('option');
      opt.value = 'dev:' + d.deviceId;
      opt.textContent = '🎙 ' + (d.label || 'input ' + d.deviceId.slice(0, 6));
      sourceSel.appendChild(opt);
      
      if (d.label && d.label.toLowerCase().includes('blackhole')) {
        targetInId = d.deviceId;
      }
      if (d.deviceId === 'default') {
        fallbackInId = 'default';
      }
    }
    
    // BlackHoleがあれば優先、なければシステムデフォルト、それもなければ先頭を選択
    const initialIn = targetInId || fallbackInId || (inDevices.length > 0 ? inDevices[0].deviceId : null);
    if (initialIn) {
      sourceSel.value = 'dev:' + initialIn;
      sourceSel.dispatchEvent(new Event('change'));
    }
    let targetOutId = null;
    let fallbackOutId = null;
    const outDevices = await AudioEngine.listOutputDevices();
    for (const d of outDevices) {
      if (d.deviceId === 'default') {
        // `default` そのものはブラウザ側の仮想的なラベルになるため、リストには追加しない（実際のデバイスを選ぶため）
        continue;
      }
      
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = '🔊 ' + (d.label || 'output ' + d.deviceId.slice(0, 6));
      outputSel.appendChild(opt);

      if (d.label && d.label.toLowerCase().includes('macbook')) {
        targetOutId = d.deviceId;
      }
    }

    const initialOut = targetOutId || fallbackOutId || (outDevices.length > 0 ? outDevices[0].deviceId : null);
    if (initialOut) {
      outputSel.value = initialOut;
      outputSel.dispatchEvent(new Event('change'));
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
  if (v === 'system') {
    try {
      await audio.useSystemAudio();
    } catch (e) {
      console.error('System Audio Error:', e);
      alert('システム音声の取得に失敗しました。画面収録の権限が必要です。');
      sourceSel.value = '';
    }
  } else if (v.startsWith('dev:')) {
    const id = v.slice(4);
    try {
      await audio.useInputDevice(id);
    } catch (e) {
      console.error(e);
    }
  }
});

// ---- 出力先選択 ----
outputSel.addEventListener('change', async () => {
  const v = outputSel.value;
  await audio.setOutputDevice(v);
});

passthroughCheckbox.addEventListener('change', (e) => {
  audio.setPassthrough(e.target.checked);
});

monitorVolumeSlider.addEventListener('input', (e) => {
  audio.setMonitorVolume(e.target.value / 100);
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
  gctx.fillStyle = '#000000';
  gctx.fillRect(0, 0, w, h);

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

  // reactionVol (瞬間的な音量) を黄色で描画
  drawLine('reactionVol', 'rgba(255, 200, 0, 0.7)');

  // hypeFactor (赤色: 実際の盛り上がり度)
  drawLine('hypeFactor', 'rgba(255, 50, 50, 1.0)');

  // songMood (青色: 蓄積された曲調)
  drawLine('songMood', 'rgba(50, 150, 255, 1.0)');

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
      const hypeFactor = latest.hypeFactor || 0;
      const featMood = latest.currentMood !== undefined ? latest.currentMood : 0.5;
      const mood = hypeFactor * featMood;
      const gw = 140;
      const gh = 8;
      // 全体の横幅を計算して中央揃えにする
      gctx.font = 'bold 12px sans-serif';
      const leftStr = 'hype(red) × vibe(blue): ';
      const rightStr = '100%';
      const leftW = gctx.measureText(leftStr).width;
      const rightW = gctx.measureText(rightStr).width;
      const gap = 8;
      const totalW = leftW + gap + gw + gap + rightW;
      
      const startX = w / 2 - totalW / 2;
      const gx = startX + leftW + gap;
      const gy = 25;

      // テキスト表示 (上部)
      gctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      gctx.textAlign = 'center';
      gctx.textBaseline = 'bottom';
      
      const currentMood = window.mascot && window.mascot.feat ? (window.mascot.feat.currentMood || 0.5) : 0.5;
      const moodLabel = currentMood < 0.5 ? 'Melodic' : 'Rhythmic';
      gctx.fillText(`Now mood: ${moodLabel}`, w / 2, gy - 4);
      
      // 左側テキスト
      gctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      gctx.textAlign = 'left';
      gctx.textBaseline = 'middle';
      gctx.fillText(leftStr, startX, gy + gh / 2 + 1);

      // ゲージの背景
      gctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      gctx.fillRect(gx, gy, gw, gh);
      
      // ゲージの中身 (青:Melodic 〜 赤:Rhythmic)
      gctx.fillStyle = `hsl(${220 - mood * 220}, 80%, 60%)`; 
      gctx.fillRect(gx, gy, gw * mood, gh);

      // パーセンテージ表示 (ゲージの右横)
      gctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      gctx.textAlign = 'left';
      gctx.textBaseline = 'middle';
      gctx.fillText(`${Math.round(mood * 100)}%`, gx + gw + gap, gy + gh / 2 + 1);
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
