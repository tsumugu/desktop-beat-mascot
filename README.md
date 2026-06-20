# Desktop Mascot 🎵💃

PCの音に合わせて踊る、Live2D風デスクトップマスコット（簡易リグMVP）。
透明・最前面のウィンドウに1枚絵を表示し、音量で揺れ・ビートでポップします。

## 使い方

```bash
npm start        # ビルド + 起動
```

> 初回の依存インストールは `npm install --cache ./.npm-cache` 済み。

起動すると画面右下にマスコットが出ます（音が無くても呼吸・バウンスの待機アニメが動きます）。
左上に薄い操作パネル（ホバーで濃くなる）があります。

### 音に合わせて踊らせる
- **mp3を試す**: パネルの音源セレクトで「🎵 mp3ファイル…」を選ぶ、または mp3 をウィンドウにドラッグ＆ドロップ。
- **システム音声（本命）**: 下記セットアップ後、セレクトに出る「🎙 BlackHole 2ch」を選択。

### 操作
- マスコット本体をドラッグ → ウィンドウ移動
- 本体以外はクリックスルー（背後のアプリを操作可）
- パネルの ✕ → 終了

## システム音声キャプチャのセットアップ（macOS）

macOSは標準で再生音を拾えないため、無料の仮想オーディオ **BlackHole** を使います。

```bash
brew install blackhole-2ch
```

1. `Audio MIDI設定`.app を開く
2. 左下「＋」→「**複数出力装置**を作成」
3. その装置で **スピーカー（内蔵出力）** と **BlackHole 2ch** の両方にチェック
   （これで自分の耳にも音が届きつつ、BlackHoleへも音が流れる）
4. メニューバーの音量 or `サウンド`設定で、出力をこの複数出力装置に切替
5. アプリの音源セレクトで **🎙 BlackHole 2ch** を選択 → 再生中の音すべてに反応

> 代替: macOS 13+ の ScreenCaptureKit なら仮想デバイス不要だがネイティブ実装が必要。MVPではBlackHole方式。

## Live2D風に“パーツ分け”して強化する（フェーズ0）

今は `assets/layers/full.png`（1枚絵）を1レイヤーとして動かしています。
パーツごとの透過PNGを用意すると、各部位を独立して動かせて一気にLive2Dらしくなります。

1. 画像編集ソフト（Photoshop / Clip Studio / Krita / GIMP）で立ち絵をパーツ分解
   - 推奨: 後ろ髪 / 胴体 / 左腕 / 右腕 / 頭 / 前髪 / 目 / 眉 / 口
   - 各パーツは**キャンバス全体サイズのまま透過で書き出す**（位置合わせのため）
   - 隠れる領域（腕の下・髪の下）は描き足し（inpaint）しておく
2. `assets/layers/` に配置
3. `renderer/rig.js` の `LAYERS` 配列にレイヤーを追加（コメントの例を参照）。
   `pivot`（支点）・`anchorAt`（配置）・`anim`（動きの種類）を指定するだけ。
   - 使える動き: `breathe`(呼吸) / `bounce`(上下) / `sway`(傾き) / `beatPop`(ビートで拡大)

## 構成

| ファイル | 役割 |
|---|---|
| `main.js` | Electron: 透明・最前面ウィンドウ、クリックスルー、ドラッグ移動IPC |
| `preload.js` | レンダラ↔main の橋渡し |
| `renderer/index.html` | ステージ + 操作パネル + CSP |
| `renderer/rig.js` | PixiJS: レイヤー配置・アニメ（データ駆動） |
| `renderer/audio.js` | Web Audio + Meyda: 音量/低域/ビート解析 |
| `renderer/app.js` | 音声特徴量 → リグへ、UI・操作 |

ビルドは esbuild（`renderer/app.js` → `renderer/dist/bundle.js`）。`npm run watch` で監視ビルド。

## 今後の拡張
- 本格Live2D: Cubism Editor（個人無料）でリギング → `.moc3` → `pixi-live2d-display`（描画基盤は流用可）
- 口パク（音量で口レイヤー差し替え）、表情・モーション追加、複数衣装
