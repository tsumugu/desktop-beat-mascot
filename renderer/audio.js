import Meyda from 'meyda';

/**
 * 音声解析エンジン。
 * 音源（mp3 の <audio> 要素 / マイク・BlackHole 等の入力デバイス）を受け取り、
 * 毎フレーム { level, bass, beat } を返す。
 *   level: 0..1 全体音量(RMS)        → バウンス量・スケール
 *   bass : 0..1 低域エネルギー        → ビートの強さ
 *   beat : boolean 立ち上がり検出     → ポップ動作のトリガ
 */
export class AudioEngine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.75;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.time = new Uint8Array(this.analyser.fftSize);
    this.floatTime = new Float32Array(this.analyser.fftSize);

    this.source = null;
    this.meyda = null;
    this.rms = 0;
    this.centroid = 0;

    // ビート検出用のエネルギー履歴
    this.energyHistory = [];
    this.midHistory = [];
    this.historySize = 43;          // ≒ 0.7秒分(60fps想定)
    this.lastBeatAt = 0;
    this.lastMidBeatAt = 0;
    this.beatRefractory = 0.18;     // 連続ビートの最小間隔(秒)

    // 曲調（雰囲気）のプロファイル（0.0: Melodic 〜 1.0: Rhythmic）
    this.songMood = 0.5;

    // 転調検知用
    this.chroma = new Array(12).fill(0);
    this.longTermChroma = new Array(12).fill(0);
    this.shortTermChroma = new Array(12).fill(0);
    this.lastKeyChangeAt = 0;

    // ピッチ・間奏検知用
    this.longTermPitch = 0;
    this.pitchConfidence = 0;
    this.lastPitch = 0;
    this.pitchDelta = 0;

  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** 既存の音源を切断 */
  _disconnectSource() {
    if (this.meyda) { try { this.meyda.stop(); } catch {} this.meyda = null; }
    if (this.source) { try { this.source.disconnect(); } catch {} this.source = null; }
  }

  /**
   * 音源を接続する。
   * @param node  AudioNode（MediaElementSource か MediaStreamSource）
   * @param playThrough  true ならスピーカーへも出力（mp3再生時。デバイス取込時は false でエコー回避）
   */
  _connect(node, playThrough) {
    this._disconnectSource();
    this.source = node;
    node.connect(this.analyser);
    if (playThrough) node.connect(this.ctx.destination);

    // Meyda で滑らかな RMS を取得
    try {
      this.meyda = Meyda.createMeydaAnalyzer({
        audioContext: this.ctx,
        source: node,
        bufferSize: 2048, // chromaの解像度を上げるため変更(1024だとエラーになる環境があるため2048へ)
        featureExtractors: ['rms', 'spectralCentroid', 'chroma'],
        callback: (f) => { 
          if (f && typeof f.rms === 'number') this.rms = f.rms; 
          if (f && typeof f.spectralCentroid === 'number') this.centroid = f.spectralCentroid;
          if (f && f.chroma) this.chroma = f.chroma;
          this._meydaActive = true; // 正常にコールバックが呼ばれたフラグ
        }
      });
      this.meyda.start();
    } catch (e) {
      console.warn('Meyda 初期化に失敗、AnalyserNode の RMS にフォールバック', e);
      this.meyda = null;
    }
  }

  /** mp3 等のメディア要素を音源にする（再生音はスピーカーへも流す） */
  async useMediaElement(audioEl) {
    await this.resume();
    const node = this.ctx.createMediaElementSource(audioEl);
    this._connect(node, true);
  }

  /** 入力デバイス（BlackHole/マイク）を音源にする */
  async useInputDevice(deviceId) {
    await this.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false
    });
    const node = this.ctx.createMediaStreamSource(stream);
    this._connect(node, false);   // 取り込み音はスピーカーへ流さない
    return stream;
  }

  /** 入力デバイス一覧 */
  static async listInputDevices() {
    // ラベル取得には一度許可が要る
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  /** 自己相関関数を用いて近似的な基本周波数（ピッチ）を推定する */
  _detectPitch(timeData, sampleRate) {
    let size = timeData.length;
    let rms = 0;
    for (let i = 0; i < size; i++) {
      rms += timeData[i] * timeData[i];
    }
    rms = Math.sqrt(rms / size);
    if (rms < 0.02) return null; // 音量が小さすぎる場合は無効

    // 相関配列の計算
    let c = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size - i; j++) {
        c[i] += timeData[j] * timeData[j + i];
      }
    }

    // 最初の下落を見つける
    let d = 0;
    while (c[d] > c[d + 1]) d++;
    if (d === size - 1) return null;

    // 次のピーク(基本周期)を見つける
    let maxval = -1, maxpos = -1;
    for (let i = d; i < size; i++) {
      if (c[i] > maxval) {
        maxval = c[i];
        maxpos = i;
      }
    }
    let T0 = maxpos;
    if (T0 === 0) return null;

    let freq = sampleRate / T0;
    // ボーカルの一般的な音域(約80Hz〜1000Hz)に制限して返す
    if (freq < 80 || freq > 1000) return null;
    return freq;
  }

  /** 毎フレーム呼ぶ。{ level, bass, beat, pitch... } を返す。 */
  tick(now) {
    if (!this.source) return { level: 0, bass: 0, beat: false, pitch: null };

    this.analyser.getByteFrequencyData(this.freq);

    // 全体音量: Meyda の RMS（無ければ time-domain から算出）
    let level = this.rms;
    // meydaが無い、もしくはmeydaのコールバックが一度も呼ばれていなくてlevelが0のままの場合はフォールバック
    if (!this.meyda || (!this._meydaActive && level === 0)) {
      this.analyser.getByteTimeDomainData(this.time);
      let sum = 0;
      for (let i = 0; i < this.time.length; i++) {
        const v = (this.time[i] - 128) / 128;
        sum += v * v;
      }
      level = Math.sqrt(sum / this.time.length);
      
      // Meydaが内部エラーで止まっている場合はMeydaを破棄して完全フォールバックに移行
      if (this.meyda && level > 0) {
        this.meyda = null;
      }
    }
    level = Math.min(1, level * 2.2);   // 見栄え用ゲイン

    // 各帯域エネルギー (fftSize=1024 なので 1bin ≒ 43Hz)
    let bassSum = 0, midSum = 0, highSum = 0;
    for (let i = 0; i < 8; i++) bassSum += this.freq[i];         // ~340Hz
    for (let i = 8; i < 70; i++) midSum += this.freq[i];         // 340Hz ~ 3kHz
    for (let i = 70; i < 200; i++) highSum += this.freq[i];      // 3kHz ~ 8.6kHz

    const bass = bassSum / (8 * 255);
    const mid = midSum / (62 * 255);
    const high = highSum / (130 * 255);

    // 曲調プロファイラー (songMood: 0.0=Melodic, 1.0=Rhythmic)
    // 低音成分が中高音成分に対してどれくらい強いかで判定する
    const totalFreq = bass + mid + high + 0.001;
    const drumRatio = bass / totalFreq;
    // drumRatio は通常 0.1(静か) 〜 0.7(EDMキック) 程度。これを 0.0〜1.0 にマッピング
    const currentMood = Math.max(0, Math.min(1, (drumRatio - 0.2) * 2.5));
    // 5〜10秒程度のゆっくりとした移動平均で曲調を追跡 (60fps想定で約0.5秒の平滑化、ただし実際はもっとゆっくり追従させる)
    this.songMood += (currentMood - this.songMood) * 0.005;

    // ビート検出: 低域エネルギーが履歴平均×感度を超え、不応期を過ぎたら true
    const energy = bass;
    const avg = this.energyHistory.length
      ? this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length
      : 0;
    let beat = false;
    const sensitivity = 1.18;
    if (energy > 0.05 && energy > avg * sensitivity &&
        now - this.lastBeatAt > this.beatRefractory) {
      beat = true;
      this.lastBeatAt = now;
    }
    this.energyHistory.push(energy);
    if (this.energyHistory.length > this.historySize) this.energyHistory.shift();

    // 合いの手用 (ボーカルやメロディなど中音域の立ち上がり)
    const midAvg = this.midHistory.length
      ? this.midHistory.reduce((a, b) => a + b, 0) / this.midHistory.length
      : 0;
    let midBeat = 0; // booleanから数値(強度)に変更
    const midSensitivity = 1.15; 
    if (mid > 0.05 && mid > midAvg * midSensitivity &&
        now - this.lastMidBeatAt > 0.35) { 
      // 静かな曲の微小な変動で倍率が爆発しないように、分母に0.02のゲタを履かせる
      midBeat = mid / (midAvg + 0.02);
      this.lastMidBeatAt = now;
    }
    this.midHistory.push(mid);
    if (this.midHistory.length > this.historySize) this.midHistory.shift();

    // 転調検知 (Key Change Detection)
    let keyChange = false;
    // 音量がある程度ある時のみプロファイルを更新
    if (level > 0.05) {
      for (let i = 0; i < 12; i++) {
        this.longTermChroma[i] += (this.chroma[i] - this.longTermChroma[i]) * 0.001; // 約10〜15秒のEMA
        this.shortTermChroma[i] += (this.chroma[i] - this.shortTermChroma[i]) * 0.05;  // 約0.5秒のEMA
      }
      
      // 盛り上がっていて、かつ前回の転調から十分な時間(15秒)が経過している場合のみ判定
      if (level > 0.15 && now - this.lastKeyChangeAt > 15) {
        const getCorrelation = (shift) => {
          let dot = 0, normS = 0, normL = 0;
          for (let i = 0; i < 12; i++) {
            const s = this.shortTermChroma[i];
            const l = this.longTermChroma[(i - shift + 12) % 12];
            dot += s * l;
            normS += s * s;
            normL += l * l;
          }
          if (normS === 0 || normL === 0) return 0;
          return dot / (Math.sqrt(normS) * Math.sqrt(normL));
        };
        // shift=0 が一番相関が高ければ転調なし。
        // shift != 0 で相関が 0.7 などを超えていて、かつ shift=0 の相関より大幅に高ければ転調とみなす。
        let maxCorr = -1, bestShift = 0;
        for (let shift = 0; shift < 12; shift++) {
          let c = getCorrelation(shift);
          if (c > maxCorr) { maxCorr = c; bestShift = shift; }
        }
        const corr0 = getCorrelation(0);
        // 条件を少し緩和 (corr0が0.6以下、maxCorrが0.75以上)
        if (bestShift !== 0 && maxCorr > 0.75 && corr0 < 0.6) {
          keyChange = true;
          this.lastKeyChangeAt = now;
          // プロファイルをリセットして新しいキーに馴染ませる
          for (let i = 0; i < 12; i++) this.longTermChroma[i] = this.shortTermChroma[i];
        }
      }
    }

    // ピッチ（音程）推定と間奏・ノリ検知用データの計算
    this.analyser.getFloatTimeDomainData(this.floatTime);
    let pitchFreq = this._detectPitch(this.floatTime, this.ctx.sampleRate);
    let pitch = null;
    
    if (pitchFreq && level > 0.05) {
      pitch = 69 + 12 * Math.log2(pitchFreq / 440); // 周波数をMIDIノート番号に変換
      this.pitchConfidence += (1.0 - this.pitchConfidence) * 0.1; // 見つかれば急速に上がる
      
      if (this.longTermPitch === 0) this.longTermPitch = pitch;
      this.longTermPitch += (pitch - this.longTermPitch) * 0.002; // 約10〜20秒の平均(ゆっくり追従)
      
      if (this.lastPitch > 0) {
        this.pitchDelta = Math.abs(pitch - this.lastPitch);
      }
      this.lastPitch = pitch;
    } else {
      this.pitchConfidence += (0.0 - this.pitchConfidence) * 0.02; // 見つからないとゆっくり下がる(間奏判定用)
      this.pitchDelta *= 0.8; // 跳躍度はすぐ減衰させる
    }

    return { 
      level, bass, mid, high, centroid: this.centroid, beat, midBeat, keyChange, 
      pitch, pitchConfidence: this.pitchConfidence, longTermPitch: this.longTermPitch, pitchDelta: this.pitchDelta,
      songMood: this.songMood // 曲調（雰囲気）
    };
  }
}
