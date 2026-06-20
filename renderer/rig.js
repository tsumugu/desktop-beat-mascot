import 'pixi.js/unsafe-eval';
import { Application, Assets, Sprite, Container, MeshPlane } from 'pixi.js';
import {
  GROUP_BY_NAME, GROUP_BY_INDEX, GROUP_CONFIG, HAIR_WAVE_PARTS,
  makeGrooveState, onBeat, tickGroove, stepSpring, hairRowOffsets,
} from './motion.js';

const HAIR_ROWS = 10; // mesh segments for hair wave

export class Rig {
  constructor() {
    this.app    = new Application();
    this.world  = new Container();
    this.items  = [];
    this.level  = 0;
    this.bass   = 0;

    this.groove = makeGrooveState(120);
    this._lastBeatT   = -1;
    this._beatPending = false;

    this._fitScale = 0.2;
    this._cx = 0; this._cy = 0;
    this._yOffset = 0; // UIなどを避けるための追加オフセット

    // 表情管理
    this.faceParts = {};
    this.currentEmotion = 'neutral';
    this.autoEmotion = true;
    this._emotionCooldown = 0;
  }

  async init(stageEl) {
    await this.app.init({
      resizeTo: stageEl, backgroundAlpha: 0, antialias: true,
      autoDensity: true, resolution: window.devicePixelRatio || 1,
    });
    stageEl.appendChild(this.app.canvas);
    this.app.stage.addChild(this.world);

    const layout = await (await fetch('../assets/layout.json')).json();
    const parts  = [...layout.parts].sort((a, b) => a.z - b.z);

    for (const p of parts) {
      const tex   = await Assets.load(`../assets/parts/${p.file}`);
      const group = GROUP_BY_NAME[p.name] ?? GROUP_BY_INDEX[p.index] ?? 'body';
      const cfg   = GROUP_CONFIG[group] ?? null;
      const isHairWave = HAIR_WAVE_PARTS.has(p.name);
      const baseRot    = (p.rot * Math.PI) / 180;

      let displayObj;

      if (isHairWave) {
        // MeshPlane: top row fixed, lower rows wave laterally
        const mesh = new MeshPlane({ texture: tex, verticesX: 2, verticesY: HAIR_ROWS + 1 });
        // Pivot in local pixel space (mirrors sprite.anchor behaviour)
        mesh.pivot.set(p.pivot[0] * tex.width, p.pivot[1] * tex.height);
        mesh.x = p.cx;
        mesh.y = p.cy;
        mesh.scale.x = (p.flip ? -1 : 1) * p.scale;
        mesh.scale.y = p.scale;
        mesh.rotation = baseRot;
        mesh.visible  = p.visible !== false;
        this.world.addChild(mesh);
        displayObj = mesh;
      } else {
        const sprite = new Sprite(tex);
        sprite.anchor.set(p.pivot[0], p.pivot[1]);
        sprite.x = p.cx;
        sprite.y = p.cy;
        sprite.scale.x = (p.flip ? -1 : 1) * p.scale;
        sprite.scale.y = p.scale;
        sprite.rotation = baseRot;
        sprite.visible  = p.visible !== false;
        this.world.addChild(sprite);
        displayObj = sprite;

        // 眉毛(28, 30)は顔パーツに統合されたため非表示にする
        if (['part_28', 'part_30'].includes(p.name)) {
          sprite.visible = false;
        }

        // 表情変化の対象パーツを保存
        if (p.name === 'part_32') {
          this.faceParts[p.name] = { sprite, baseFile: p.file };
        }
      }

      this.items.push({
        obj: displayObj,
        group,
        cfg,
        isHairWave,
        index:     p.index,
        flip:      p.flip,
        pivotX:    p.pivot[0],
        pivotY:    p.pivot[1],
        baseX:     p.cx,
        baseY:     p.cy,
        baseScale: p.scale,
        baseRot,
        // spring state
        sp: { ang: 0, vel: 0 },
        // hair mesh: cache base vertices + buffer ref
        baseMeshVerts: isHairWave ? new Float32Array(displayObj.geometry.buffers[0].data) : null,
        meshBuf:       isHairWave ? displayObj.geometry.buffers[0] : null,
      });
    }

    // まばたき: 目(part_32=開き)に閉じテクスチャ(part_31)を用意してテクスチャ差し替え
    this._eyesItem = this.items.find((it) => it.index === 32) || null;
    if (this._eyesItem) {
      try {
        this._eyeOpenTex   = this._eyesItem.obj.texture;
        this._eyeClosedTex = await Assets.load('../assets/parts/part_31.png');
        // サイズが2倍になり完全互換になったためスケール補正は不要
        this._eyeRatio = 1;
      } catch (e) { console.warn('閉じ目(part_31)の読み込みに失敗', e); this._eyesItem = null; }
    }
    this._blinkEnabled  = true;                // まばたき有効
    this._blinkCloseT   = 0;                   // >0 の間は目を閉じる(秒)
    this._nextBlinkIn   = this._randBlinkGap();
    this._pendingSecond = false;

    // 開始時は開き目（補正スケール）で表示
    if (this._eyesItem) this._setEye(false);

    // 頭グループの共通回転軸（顎＝顔パーツの下端）を計算
    const faceIt = this.items.find(it => it.index === 2 || it.name === 'face');
    if (faceIt) {
      const th = faceIt.obj.texture.height;
      this._headPivotX = faceIt.baseX;
      // 顔の下端 = baseY + (1 - pivotY) * height * scale
      this._headPivotY = faceIt.baseY + (1 - faceIt.pivotY) * th * faceIt.baseScale;
    } else {
      this._headPivotX = 1046;
      this._headPivotY = 1100;
    }

    this._fitWorld();
    this.app.renderer.on('resize', () => this._fitWorld());
    this.app.ticker.add((t) => this._update(t.deltaMS / 1000));
    return this;
  }

  async setEmotion(emotion) {
    if (this.currentEmotion === emotion) return;
    this.currentEmotion = emotion;
    const suffix = emotion === 'neutral' ? '' : `_${emotion}`;

    for (const [name, info] of Object.entries(this.faceParts)) {
      const base = info.baseFile;
      const ext = base.slice(base.lastIndexOf('.'));
      const targetFile = base.slice(0, base.lastIndexOf('.')) + suffix + ext;

      try {
        const tex = await Assets.load(`../assets/parts/${targetFile}`);
        info.sprite.texture = tex;

        // まばたき用に開き目のテクスチャキャッシュも更新する
        if (name === 'part_32' && this._eyesItem) {
          this._eyeOpenTex = tex;
          if (emotion !== 'neutral') {
            this._blinkCloseT = 0; // neutral以外ではまばたきをキャンセル
          }
        }
      } catch (e) {
        // パーツが用意されていない場合はエラーを出さずに無視する
      }
    }
  }

  _fitWorld() {
    const W = this.app.renderer.width  / this.app.renderer.resolution;
    const H = this.app.renderer.height / this.app.renderer.resolution;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const { obj, pivotX, pivotY, baseX, baseY, baseScale } of this.items) {
      if (!obj.visible) continue;
      const tw = obj.texture.width, th = obj.texture.height;
      minX = Math.min(minX, baseX - pivotX * tw * baseScale);
      maxX = Math.max(maxX, baseX + (1 - pivotX) * tw * baseScale);
      minY = Math.min(minY, baseY - pivotY * th * baseScale);
      maxY = Math.max(maxY, baseY + (1 - pivotY) * th * baseScale);
    }

    const charW = maxX - minX || 1, charH = maxY - minY || 1;

    // ---- 表示調整用定数 ----
    // CHAR_SCALE: キャラの表示倍率（world px → screen px）。ウインドウサイズに依存せず固定。
    //             増やす→大きく / 減らす→小さく
    const CHAR_SCALE = 0.1;
    // TOP_PAD: キャラ上端を画面上端からこのpx分だけ下げる
    const TOP_PAD = 50;
    // ------------------------

    this._fitScale = CHAR_SCALE;

    // 位置はウインドウに追従：横は中央寄せ、縦はキャラ上端を TOP_PAD に置く
    const charCenterX = minX + charW / 2;
    const charTopY    = minY;
    this.world.pivot.set(charCenterX, charTopY);
    this._cx = W / 2;
    this._cy = TOP_PAD;  // pivot(上端)をこの高さに表示
  }

  setYOffset(offset) {
    this._yOffset = offset;
  }

  setAudio(feat = {}) {
    this.feat = feat;
    this.level = feat.level || 0;
    this.bass  = feat.bass || 0;
    if (feat.beat) this._beatPending = true;
    if (feat.midBeat) this._midBeatPending = true;
  }

  // 次のまばたきまでの間隔（秒）。2.0〜4.5秒（平均≈3.25秒＝毎分約18回）。
  // 人の自発まばたきは安静時 毎分15〜20回（3〜4秒に1回）が標準。
  _randBlinkGap() { return 2.0 + Math.random() * 2.5; }

  // 目テクスチャを開き/閉じに差し替え。
  _setEye(closed) {
    const it = this._eyesItem; if (!it) return;
    const s = it.baseScale * (closed ? this._eyeRatio : 1);
    it.obj.texture = closed ? this._eyeClosedTex : this._eyeOpenTex;
    it.obj.scale.set((it.flip ? -1 : 1) * s, s);
  }

  // まばたき: 一定間隔で目を閉じ→開き。たまに二度まばたき。
  _updateBlink(dt) {
    if (!this._eyesItem) return;

    // 間奏中（歌唱中ではなく、ある程度の音量がある時）かつニュートラルな表情なら、目を閉じて音に浸る
    if (this.currentEmotion === 'neutral' && this.debugData && this.debugData.isVocal === false && this.level > 0.05) {
      if (Assets.get('part_31')) {
        this._eyesItem.obj.texture = Assets.get('part_31');
      }
      this._wasInterlude = true;
      return;
    }

    if (this._wasInterlude) {
      this._setEye(false); // 間奏が明けた時に目を開ける
      this._wasInterlude = false;
    }

    if (this.currentEmotion !== 'neutral') {
      // ニュートラル以外は瞬きしない（表情固定）
      if (this._eyeOpenTex) this._eyesItem.obj.texture = this._eyeOpenTex;
      return;
    }
    if (this._blinkCloseT > 0) {
      this._blinkCloseT -= dt;
      if (this._blinkCloseT <= 0) {
        this._setEye(false);                         // 開く
        if (this._pendingSecond) { this._pendingSecond = false; this._nextBlinkIn = 0.12; }
        else this._nextBlinkIn = this._randBlinkGap();
      }
    } else {
      this._nextBlinkIn -= dt;
      if (this._nextBlinkIn <= 0) {
        this._setEye(true);                          // 閉じる
        this._blinkCloseT   = 0.10;                  // 閉じ時間(秒)
        this._pendingSecond = Math.random() < 0.15;  // 15%で二度まばたき
      }
    }
  }

  _update(dt) {
    if (dt > 0.1) dt = 0.1;

    // Beat: update BPM + snap phase
    if (this._beatPending) {
      this._beatPending = false;
      if (this._lastBeatT >= 0) {
        const iv = this.groove.t - this._lastBeatT;
        if (iv > 0.27 && iv < 1.3)
          this.groove.beatPeriod += (iv - this.groove.beatPeriod) * 0.35;
      }
      this._lastBeatT = this.groove.t;
      onBeat(this.groove);
    }

    const frameFeat = {
      ...(this.feat || {}),
      midBeat: this._midBeatPending
    };
    this._midBeatPending = false;

    const g = tickGroove(this.groove, dt, frameFeat);

    // グラフ描画用データの保存
    this.debugData = {
      hypeFactor: g.hypeFactor,
      targetHype: g.targetHype,
      reactionVol: g.reactionVol,
      keyChange: g.keyChange,
      isVocal: g.isVocal,
      pitchDelta: g.pitchDelta,
      pitchHypeBonus: g.pitchHypeBonus
    };

    this._updateBlink(dt);

    // 横=BPM位相 / 上下=音量 + UI回避のYオフセット
    this.world.x        = this._cx + g.sway * g.swayPx;
    this.world.y        = this._cy - g.bouncePx + this._yOffset;
    this.world.rotation = g.tilt;

    // 泣き顔判定用タイマー: 無音ではなく、かつテンションが低い(Hype<0.2)状態の継続時間を計測
    if (this.level > 0.01 && g.hypeFactor < 0.2) {
      this._lowHypeTimer = (this._lowHypeTimer || 0) + dt;
    } else {
      this._lowHypeTimer = 0;
    }

    // 自動表情変化
    if (g.keyChange) {
      // 転調検知時: 最優先でexciteになり、長め(3秒間)にキープする
      this.setEmotion('excite');
      this._emotionCooldown = 3.0;
    } else if (g.pitchDelta > 12 && g.midBeat > 0.3 && this._emotionCooldown <= 0) {
      // 音程の激しい跳躍（1オクターブ以上）＋アタックがあった時、瞬間的にexcite
      this.setEmotion('excite');
      this._emotionCooldown = 0.8;
    } else if (this.autoEmotion && this._emotionCooldown <= 0) {
      if (g.midBeat > 1.3 || g.hypeFactor > 0.92) {
        // ボーカルのアクセント(しきい値を1.3へ低下)、または曲のテンションが最高潮(Hype>0.92)の時に(>o<)になる
        this.setEmotion('excite');
        this._emotionCooldown = 1.2; // 1.2秒間維持
      } else if (g.hypeFactor > 0.7) {
        // サビの通常時は笑顔
        this.setEmotion('happy');
      } else if (this._lowHypeTimer > 60) {
        // 無音ではなく、静かな状態が60秒以上続いた場合のみ泣く(バラード等の表現)
        this.setEmotion('cry');
      } else {
        this.setEmotion('neutral');
      }
    }
    if (this._emotionCooldown > 0) this._emotionCooldown -= dt;

    this.world.scale.set(
      this._fitScale,
      this._fitScale * (1 + g.breathe),
    );

    // 頭グループ（顔、髪など）の共通回転角度（顎軸）を事前計算
    const headCfg = GROUP_CONFIG['head'];
    let headAng = 0;
    if (headCfg) {
      if (!this._headSp) this._headSp = { ang: 0, vel: 0 };
      let target = g.hairDrive * headCfg.gain * headCfg.dir;
      // 体の上下動が減った分、頭が前へ「うなずく」角度を大きくしてノリを表現
      target += g.bouncePx * 0.008;
      headAng = stepSpring(this._headSp, target, headCfg, dt);
    }
    const headAttached = new Set(['head', 'bangs', 'hairBack', 'bun']);

    // Per-part secondary motion
    for (const it of this.items) {
      // 1. 各パーツ固有のスプリング回転
      let ang = 0;
      if (it.cfg && it.group !== 'head') {
        let target = g.hairDrive * it.cfg.gain * it.cfg.dir;

        // 腕の独立した反動（上下バウンスに応じた慣性）
        if (it.group === 'armL' || it.group === 'armR') {
          // 柔らかすぎると「外から揺らされている(脱力)」感じが出てしまうため、
          // 筋肉で姿勢を保持している緊張感を出すべく、反動を少し抑えめにします
          target += g.bouncePx * 0.005 * it.cfg.dir;
        }

        ang = stepSpring(it.sp, target, it.cfg, dt);
      }

      // 2. メッシュウェーブの更新
      if (it.isHairWave) {
        const offsets = hairRowOffsets(g.t, g.sway, g.act, HAIR_ROWS + 1);
        const base = it.baseMeshVerts;
        const buf  = it.meshBuf;
        for (let r = 0; r <= HAIR_ROWS; r++) {
          const dx = offsets[r];
          buf.data[r * 4 + 0] = base[r * 4 + 0] + dx;
          buf.data[r * 4 + 2] = base[r * 4 + 2] + dx;
        }
        buf.update();
      }

      // 3. 基本の回転と位置
      let finalRot = it.baseRot + ang;
      let finalX = it.baseX;
      let finalY = it.baseY;

      // 個別のバウンス(yLag)
      let ownBounce = 0;
      if (it.isHairWave) {
        ownBounce = g.bouncePx * 0.15;
      } else if (it.cfg && it.group !== 'head') {
        ownBounce = g.bouncePx * (it.cfg.yLag / 20);
      }
      finalY += ownBounce;

      // 4. 頭に付随するパーツは、顎を中心に headAng 分だけ公転・自転
      if (headAttached.has(it.group) && this._headPivotX) {
        finalRot += headAng;

        const cx = this._headPivotX;
        const cy = this._headPivotY;
        const dx = finalX - cx;
        const dy = finalY - cy;
        const cosA = Math.cos(headAng);
        const sinA = Math.sin(headAng);

        finalX = cx + dx * cosA - dy * sinA;
        finalY = cy + dx * sinA + dy * cosA;

        // 回転後に頭全体のバウンスと合いの手の上下動を加算
        if (headCfg) {
          finalY += g.bouncePx * (headCfg.yLag / 20);
          finalY += (g.headBob || 0); // 合いの手による頭の上下動
        }
      }

      it.obj.rotation = finalRot;
      it.obj.x = finalX;
      it.obj.y = finalY;
    }
  }

  getBounds() {
    const b = this.world.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }
}
