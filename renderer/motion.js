// renderer/motion.js — shared pure-function dance logic (PixiJS rig + Canvas2D editor)

export const GROUP_BY_NAME = {
  back_hair: 'hairBack', bun: 'bun',
  bangs: 'bangs', face: 'head',
  arm_l: 'armL', arm_r: 'armR',
  neck_chest: 'body', cardigan: 'body', yellow_bow: 'body',
};
export const GROUP_BY_INDEX = {
  25: 'body', 32: 'head', 27: 'head', 28: 'head', 29: 'head', 30: 'head',
};

// gain = max rotation (rad); k/c = spring stiffness/damping; dir = sway direction; yLag = hop follow-px
export const GROUP_CONFIG = {
  body:     null,
  head:     { gain: 0.060, k: 60,  c: 7.0, dir:  1, yLag: 2 },
  armL:     { gain: 0.080, k: 64,  c: 7.5, dir:  1, yLag: 3 },
  armR:     { gain: 0.080, k: 64,  c: 7.5, dir: -1, yLag: 3 },
  bun:      { gain: 0.060, k: 55,  c: 6.0, dir:  1, yLag: 5 },
  hairBack: null, // mesh wave only — no rigid rotation
};

// Parts that get MeshPlane wave instead of rigid rotation
export const HAIR_WAVE_PARTS = new Set(['back_hair', 'bangs']);

export function makeGrooveState(bpm = 120) {
  return {
    beatPeriod: 60 / bpm,  // 検出テンポ（秒/拍）
    bodyPhase: 0,          // 横揺れ位相（1拍でπ進む＝2拍で1往復）
    beatActive: 0,         // 直近ビートの活性度 0..1
    swayEnv: 0,            // 横揺れ振幅の包絡（音の有無で滑らかに増減）
    levelSmooth: 0,        // 音量の1段目スムージング
    bounce: 0,             // 上下動の2段目ローパス（px）
    t: 0,
    grooveEnergy: 0,       // フライホイール(自律振動)のエネルギー
    vibe: 0,               // 0=横揺れ中心, 1=縦ノリ中心
    headBob: 0,            // 合いの手の頭の上下移動
    headBobVel: 0,
    longTermEnergy: 0,     // 長期的な音量（数秒の平均）
    peakEnergy: 0.001,     // 曲の最大盛り上がり（サビ判定用）
    hypeFactor: 0.5,       // 盛り上がり度（0.0〜1.0）
  };
}

// 検出したビートごとに呼ぶ：位相をやんわり整列（ガクつかせない）
export function onBeat(state) {
  // 拍の瞬間に揺れが端（sin=±1）へ来るよう、近い目標位相へ少しだけ寄せる
  const k = Math.round((state.bodyPhase - Math.PI / 2) / Math.PI);
  const targetPhase = Math.PI / 2 + k * Math.PI;
  state.bodyPhase += (targetPhase - state.bodyPhase) * 0.12;  // 0.12=ゆるい補正
  state.beatActive = 1;
}

// feat = { level, bass, mid, high, centroid, beat, midBeat }
export function tickGroove(state, dt, feat = {}) {
  if (dt > 0.1) dt = 0.1;
  state.t += dt;
  // 連続位相：検出テンポで滑らかに進む（拍ごとにビクッとしない）
  state.bodyPhase += dt * (Math.PI / state.beatPeriod);
  state.beatActive = Math.max(0, state.beatActive - dt / (state.beatPeriod * 1.4));

  // 合いの手 (頭の上下のみ): midBeat の強度に応じたインパルスを与える
  if (feat.midBeat > 0) {
    // feat.midBeat は中音域の「平均に対する倍率」
    const intensity = Math.min(feat.midBeat, 3.0); // 最大値クリップを厳しめに(3.0)
    // エモーショナルなボーカルで過剰にヘドバンしないようにインパルスを抑える (40〜120程度)
    const impulse = 40.0 + (intensity - 1.0) * 40.0;

    // 確実に視覚的な移動量を出すため、マイナス速度を打ち消して上書き
    state.headBobVel = Math.max(state.headBobVel, 0) + impulse;
  }

  // 音量1段目：非対称スムージング（立ち上がり少し速く・収まりゆっくり）
  const level = feat.level || 0;
  const lvTarget = Math.min(1, level * 1.6);
  const la = (lvTarget > state.levelSmooth) ? 0.3 : 0.1;
  state.levelSmooth += (lvTarget - state.levelSmooth) * la;
  const vol = state.levelSmooth;

  // 楽器構成によるリアクションの重み付け (ドラムは1.0、ピアノ/ボーカル等は0.5)
  const bass = feat.bass || 0;
  const mid = feat.mid || 0;
  const high = feat.high || 0;
  const totalFreq = bass + mid + high + 0.001;
  const drumRatio = bass / totalFreq; // 低音の占める割合
  // ドラム中心なら1.0、中高音(ピアノ等)中心なら0.5に近づく係数
  const reactionWeight = 0.5 + Math.min(1.0, drumRatio * 1.5) * 0.5;
  const reactionVol = vol * reactionWeight;

  // 楽曲展開（サビ・間奏）を検知する Macroscopic Dynamics 処理
  // 1. 長期エネルギーの追跡（非対称スムージング）
  // AGC(自動音量調整)が入ったため、下限(0.35)のハードコードは不要。無音時の0割防止程度にする。
  const effectivePeak = Math.max(state.peakEnergy, 0.05); 
  if (vol > state.peakEnergy) state.peakEnergy += (vol - state.peakEnergy) * 0.1;
  else state.peakEnergy += (vol - state.peakEnergy) * 0.0005;

  state.longTermEnergy += (vol - state.longTermEnergy) * (vol > state.longTermEnergy ? 0.02 : 0.001);

  // 2. ピークに対する現在のエネルギーの割合からHypeを算出
  // 瞬間的な音量(reactionVol)の割合を下げて(20%)、長期的なエネルギー(80%)を重視することで
  // targetHype（黄色線）が毎フレーム暴れるのを防ぎ、より安定した曲の展開を表現する
  let energyRatio = (state.longTermEnergy * 0.8 + reactionVol * 0.2) / (effectivePeak + 0.001);

  // 一次関数だとAGC環境下で常に1.0に張り付いてしまうため、べき乗（3乗）にしてダイナミクスを強調する
  // 1.0 (サビ) -> 1.0,  0.8 (Aメロ) -> 0.51,  0.6 (静か) -> 0.21
  let targetHype = Math.pow(Math.max(0, Math.min(1.0, energyRatio)), 3.0);

  // 【追加】ピッチの高さによるHypeボーナス (新時代的な高音域での爆発)
  let pitchHypeBonus = 0;
  if (feat.pitch && feat.longTermPitch > 0) {
    const pitchDiff = feat.pitch - feat.longTermPitch;
    if (pitchDiff > 7) { // 全体の平均ピッチより7半音(完全5度)以上高い高音域のとき
      pitchHypeBonus = Math.min(0.6, (pitchDiff - 7) * 0.08); // 最大0.6のボーナス
    }
  }
  targetHype = Math.min(1.0, targetHype + pitchHypeBonus);

  // 転調(keyChange)ボーナス: 誤検知が多いため、少しテンションを引き上げる程度に留める
  if (feat.keyChange) {
    targetHype = Math.min(1.0, targetHype + 0.3);
  }

  // 曲調プロファイル (0.0: Melodic 〜 1.0: Rhythmic)
  const mood = feat.songMood || 0.5;

  // Hype自体の変化スピードを曲調に合わせて変える
  // Rhythmic(1.0)なら上がりやすく冷めやすい（キレがある）、Melodic(0.0)ならゆっくり上がりゆっくり冷める（余韻がある）
  const attackSpeed = 0.5 + mood * 2.5; // 0.5 〜 3.0
  const decaySpeed = 0.05 + mood * 0.75;  // 0.05 〜 0.8
  const hypeSpeed = targetHype > state.hypeFactor ? attackSpeed : decaySpeed;
  state.hypeFactor += (targetHype - state.hypeFactor) * Math.min(1, dt * hypeSpeed);

  // 揺れ振幅の包絡：音があれば滑らかに開き、無音で滑らかに閉じて静止する
  const presence = Math.min(1, reactionVol * 3);
  state.swayEnv += (presence - state.swayEnv) * (presence > state.swayEnv ? 0.06 : 0.03);
  const env = state.swayEnv;   // 無音→0（揺れが収まる）

  // フライホイール（自律振動）エネルギーの更新
  // 間奏などでドラムが無くても、音量があればある程度エネルギーを維持できるよう配分を変更
  // ※ここで単なる音量(vol)ではなく重み付け音量(reactionVol)を使い、ドラムでよりノリやすくする
  const inputEnergy = state.beatActive * 0.5 + reactionVol * 0.6;
  state.grooveEnergy += (inputEnergy - state.grooveEnergy) * dt * 1.5;

  // 縦ノリ度合い (Vibe): 低音が中高音より強い時に1へ近づく
  const isHeavy = feat.bass > 0.1 && feat.bass > (feat.mid || 0) * 0.7;
  const targetVibe = isHeavy ? 1.0 : 0.0;
  state.vibe += (targetVibe - state.vibe) * dt * 2.0;

  const swayPhase = Math.sin(state.bodyPhase);
  // 横揺れ：少し控えめに調整 (最大1.3倍)
  const hypeScaleSway = 0.3 + state.hypeFactor * 1.0; // Hype=0なら0.3倍、Hype=1なら1.3倍
  const swayAmp = env * hypeScaleSway * (1.0 - state.vibe * 0.4);
  const sway = swayPhase * swayAmp;

  // 「外からの力」ではなく「自らの筋肉」で動く(能動的)ようにするためのコツ：
  // 動きを遅らせる(受動的)のではなく、逆に「移動する方向へ先に体重を傾ける(先行)」こと。
  // 位相を少しプラス(先行)させることで、意思を持った体重移動(Weight Shift)になります。
  const tiltPhase = Math.sin(state.bodyPhase + 0.4);
  const tilt = tiltPhase * swayAmp * 0.06;

  // 【人間らしいノリ】予測とフライホイールに基づくバウンス
  const phaseDelay = 0.25; // わずかに遅らせる（タメ）
  const bouncePhase = Math.sin(state.bodyPhase - phaseDelay);
  const baseBounce = bouncePhase * bouncePhase;

  // バウンスの深さ：体全体の上下動は控えめにし、頭のうなずきに任せる
  const hypeScaleBounce = 0.2 + state.hypeFactor * 1.8; // Hype=0なら0.2倍、Hype=1なら2.0倍
  const bounceDepth = (2 + state.grooveEnergy * (3 + state.vibe * 12)) * hypeScaleBounce;
  // 直接的な上下のリアクションも重み付け(reactionVol)を使い、ピアノ等では跳ねすぎないようにする
  const bounceTarget = baseBounce * env * bounceDepth + reactionVol * 5;

  // 波の形を崩さず滑らかに追従させる
  const prevBounce = state.bounce;
  state.bounce += (bounceTarget - state.bounce) * Math.min(1, dt * 12);
  const bounceVel = (state.bounce - prevBounce) / dt;

  // 曲調（songMood）によるノリ方の変化
  // Melodicなほど横揺れ(sway)を強調し、Rhythmicなほど縦ノリ(bounce)を強調する
  const swayMoodMod = 0.8 + (1.0 - mood) * 1.0; // mood=0(Melodic)で1.8倍、mood=1(Rhythmic)で0.8倍
  const bounceMoodMod = 0.5 + mood * 1.0;       // mood=0で0.5倍、mood=1で1.5倍

  // 間奏（ボーカル不在）時のノリの変化も組み合わせる
  // 急激な値のジャンプによる全身の「小刻みな揺れ」を防ぐため、滑らかにブレンドする
  const pitchConf = feat.pitchConfidence || 0;
  const isVocal = pitchConf > 0.4;
  const vocalPresence = Math.max(0, Math.min(1, pitchConf * 1.5));
  const swayMultiplier = (0.6 + 0.4 * vocalPresence) * swayMoodMod;
  let bounceMultiplier = (1.3 - 0.3 * vocalPresence) * bounceMoodMod;

  // excite状態(テンションが高い時)は縦ノリをさらに強くする
  if (state.hypeFactor > 0.9) {
    bounceMultiplier *= 1.8;
  }

  // ピンクの点（高音域での爆発）に合わせた、うなづきの目標値
  let headBobTarget = 0;
  if (pitchHypeBonus > 0) {
    // 振幅が小さいとスプリングで相殺されて見えなくなるため、最低値(80.0)を保証する
    const amp = Math.max(80.0, pitchHypeBonus * 160.0);
    headBobTarget = amp * Math.max(0, Math.sin(state.bodyPhase * 2.0));
  }

  // 合いの手用スプリング（headBobTargetに滑らかに収束する）
  // 物理バネを使うことで、瞬間的なワープ（ビクビク）を防ぎ、自然に下がって戻る動きを作る
  state.headBobVel += (40 * (headBobTarget - state.headBob) - 8 * state.headBobVel) * dt;
  state.headBob += state.headBobVel * dt;

  return {
    sway: sway * swayMultiplier,
    act:       state.grooveEnergy,
    vol,
    t:         state.t,
    hairDrive: sway * (0.8 + 0.4 * vol),
    swayPx:    34,
    bounceVel,
    bouncePx:  state.bounce * bounceMultiplier,
    tilt:      tilt * swayMultiplier,
    breathe:   Math.sin(state.t * 1.6) * 0.006,
    headBob:   state.headBob,
    hypeFactor: state.hypeFactor,           // 感情変化用
    midBeat:   feat.midBeat || 0,           // 感情変化用
    reactionVol: reactionVol,
    targetHype: targetHype,
    keyChange: feat.keyChange || false,
    isVocal:   isVocal,                     // 歌唱中/間奏の判定
    pitchDelta: feat.pitchDelta || 0,       // ピッチの跳躍度
    pitchHypeBonus: pitchHypeBonus          // ピッチによるHype加算分
  };
}

// Semi-implicit Euler spring step. Mutates sp {ang, vel}. Returns new angle.
export function stepSpring(sp, target, cfg, dt) {
  sp.vel += (cfg.k * (target - sp.ang) - cfg.c * sp.vel) * dt;
  sp.ang += sp.vel * dt;
  return sp.ang;
}

// Per-row x offsets for hair wave. Row 0 = root (always 0), last row = tip.
// Returns Float32Array of length `rows`.
export function hairRowOffsets(t, sway, act, rows) {
  const out = new Float32Array(rows);
  for (let r = 1; r < rows; r++) {
    const frac = r / (rows - 1);
    const amp  = frac * frac * (18 + 12 * act);
    out[r] = Math.sin(t * 3.5 + frac * 2.8) * amp * sway;
  }
  return out;
}
