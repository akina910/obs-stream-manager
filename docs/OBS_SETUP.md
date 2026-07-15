# OBS セットアップ

## 0. アプリの起動と終了

インストーラー版は初回起動後、Windowsログイン時に画面を出さずOBSドック用サーバーを準備します。利用者がNode.jsやローカルサーバーを別途インストール・起動する必要はありません。Portable版は自動起動へ登録しないため、OBSより先にPortable EXEを起動します。

デスクトップ画面の×は通知領域への格納です。`http://127.0.0.1:4317` のドックを維持するため、サーバーは動作を続けます。EXEの再実行または通知領域の「開く」で画面を戻せます。「完全に終了」を選んだ場合だけサーバーも停止し、OBSドックは接続できなくなります。

## 1. 事前バックアップ

初回作業前に OBS の「プロファイル」と「シーンコレクション」をエクスポートし、OBS 設定ディレクトリと Stream Deck プロファイルを別の場所へコピーしてください。本アプリは OBS の設定 JSON を直接編集しません。

## 2. プロファイルとシーン

OBS プロファイルを `MAIN_YOUTUBE_TWITCH`、シーンコレクションを `STREAM_MAIN` とし、次のシーンを作成します。

```text
00_STARTING
10_GAME_PC
11_GAME_SWITCH
20_TALK
30_AWAY
40_TECHNICAL_DIFFICULTIES
90_ENDING
```

ゲームごとにシーンや OBS プロファイルを複製しないでください。ゲーム差分は本アプリのゲームプロファイルに保存します。

## 3. ソース名

アプリの初期値は次の名前を参照します。既存ソース名を使う場合はアプリの設定とゲームプロファイル側を変更します。

```text
映像: PC Game Capture / GFN Capture / PC Window Capture / Elgato Game Capture
音声: MIC / GAME_PC / GAME_GFN / GAME_SWITCH / DISCORD / BGM / ALERT
```

`10_GAME_PC` には PC、GFN、予備ウィンドウのキャプチャを配置します。`11_GAME_SWITCH` には Elgato の映像・音声を配置します。ゲーム選択時に対象キャプチャだけが有効になります。

## 4. OBS WebSocket

「ツール」→「WebSocket サーバー設定」でサーバーを有効にします。

```text
URL: ws://127.0.0.1:4455
パスワード: 任意（設定画面から OS 資格情報ストアへ保存）
```

## 5. 音声

マイクフィルターは次の順序で一度だけ設定します。

1. RNNoise ノイズ抑制
2. エキスパンダー（2.5:1、-45 dB 前後）
3. EQ
4. コンプレッサー（3:1、-18 dB 前後）
5. リミッター（-2 dB）

ゲーム音には、マイクをサイドチェイン入力にしたコンプレッサーを追加し、発話中に 4〜6 dB 下がるよう調整します。

```text
Track 1: 配信完成音
Track 2: マイク
Track 3: ゲーム音
Track 4: Discord
Track 5: BGM
Track 6: 予備 / Switch
```

## 6. 録画とプラグイン

- OBS 録画形式は MKV にします。
- リプレイバッファを有効にします。秒数はゲーム選択時にアプリが更新します。
- OBS Stream Manager Output は配布物に同梱され、アプリ起動時にユーザー用OBSプラグイン領域へ自動配置されます。初回または更新後はOBSを再起動してください。
- Source Record はゲーム映像ソース一系統だけへフィルターを設定します。アプリは Source Record の公式 WebSocket vendor request で選択ソースの録画を開始・停止します。
- Aitum Vertical は 1080×1920 の録画を作ります。アプリは Aitum Vertical の公式 WebSocket vendor request で縦録画を開始・停止します。

Source RecordまたはAitum Verticalが未導入、無効、またはvendor request非対応の場合は警告を表示し、該当する追加録画だけをスキップします。

Twitch配信キーはOAuthで取得してWindows資格情報へ保存し、配信開始時だけOBS Stream Manager Outputへ渡します。通常設定、Aitum設定、ログ、バックアップには保存しません。設定画面の「Twitch映像送信をテスト」は`bandwidthtest=true`を使うため視聴者には公開されません。通常配信時は実配信状態表示でTwitchが`LIVE`になったことを確認してください。

## 7. Advanced Scene Switcher

次のマクロを作成します。

- 配信中にゲーム映像が一定時間非アクティブ → `40_TECHNICAL_DIFFICULTIES`
- ローカルゲームまたは GFN が終了 → `30_AWAY`、ゲーム音ミュート
- 配信開始後に MIC が一定時間完全無音 → 警告
- 映像復帰 → 元のゲームシーン

本番前に各条件を意図的に発生させ、安全画面へ切り替わることを確認してください。

## 8. 本番前チェック

- YouTube を限定公開にして配信枠、タイトル、サムネイルを確認
- Twitch のタイトル、カテゴリ、タグを確認
- YouTube / Twitch コメントがドックへ表示されることを確認
- PC、GFN、Switch、VALORANT、Roblox の各キャプチャを確認
- マイク無音、ゲーム映像消失、片方の配信失敗を確認
- 通常録画、Source Record、Vertical、リプレイ保存を確認
- OBS 統計で描画遅延、エンコード遅延、ネットワークドロップを確認

