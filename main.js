const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

let win;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 420;
  const H = 255;

  win = new BrowserWindow({
    width: W,
    height: H,
    // 画面右下に初期配置
    x: workArea.x + workArea.width - W - 24,
    y: workArea.y + workArea.height - H - 24,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    // 透明ウィンドウでの描画品質安定化
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 全ワークスペース・最前面（スクリーンセーバーより上）
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 既定はクリックスルー。forward:true で mousemove だけは renderer に届くので、
  // マスコット/操作パネルの上に来たときだけ renderer から無効化を解除する。
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// renderer からのクリックスルー切替
ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  if (!win) return;
  win.setIgnoreMouseEvents(ignore, { forward: true });
});

// マスコット本体ドラッグでウィンドウ移動 (dx, dy 相対移動)
ipcMain.on('move-window-by', (_e, { dx, dy }) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

// グラフ表示時にウインドウを拡張する（下端固定で上方向に広げる）
ipcMain.on('expand-window-by', (_e, dy) => {
  if (!win) return;
  const [w, h] = win.getSize();
  const [x, y] = win.getPosition();
  // dy > 0 のとき y は上に移動し、height は増える = 画面上の下端は同じ位置をキープ
  win.setBounds({ x, y: y - dy, width: w, height: h + dy });
});

ipcMain.on('quit-app', () => app.quit());

app.whenReady().then(() => {
  const { session, desktopCapturer } = require('electron');
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      // 最初のディスプレイを選択し、システムオーディオ（loopback）を含める
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(err => {
      console.error('Error getting sources:', err);
      callback();
    });
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
