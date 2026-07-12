# OBS Stream Manager

YouTube を主配信先、Twitch を副配信先として使うための、ローカルファーストな OBS ブラウザドックです。ゲームを選択して「配信開始」を押すだけで、OBS のシーン・キャプチャ・音量・録画・リプレイと配信先メタデータをまとめて適用します。

> 初期リリースです。本番配信前に、限定公開の YouTube 枠と Twitch テストアカウントで必ず動作確認してください。

## 主な機能

- PC／Nintendo Switch／例外ゲームを一つのドックで管理
- ローカルゲーム、GeForce NOW、ウィンドウ、Elgato のキャプチャ切替
- OBS WebSocket によるシーン、映像ソース、音量、録画、リプレイ操作
- YouTube 配信枠の作成・更新、タイトル、説明、公開範囲、ゲーム別サムネイルの初回登録後自動適用
- Twitch タイトル、カテゴリ、タグの自動適用
- YouTube と Twitch のコメント統合表示
- Steam 所有ゲーム API とローカルインストール検出、App ID／ゲーム名による重複統合
- ゲーム別サムネイル、音量、録画先、リプレイ時間
- 設定とゲームプロファイルのバックアップ・復元
- OS 資格情報ストアによる OAuth トークン、API キー、OBS パスワードの保護
- Stream Deck から呼べるローカル HTTP API
- Source Record と Aitum Vertical の個別録画制御（失敗時も本配信は継続）

## 必要環境

- Windows 11（配信本番の推奨環境）
- Node.js 22 以上
- OBS Studio 30 以上（WebSocket サーバーを有効化）
- Aitum Multistream
- 必要に応じて Aitum Vertical、Source Record、Advanced Scene Switcher

開発と設定編集は macOS／Linux でも可能ですが、Game Pass、GeForce NOW、Elgato を含む本番確認は Windows で行ってください。

## セットアップ

```powershell
git clone https://github.com/akina910/obs-stream-manager.git
cd obs-stream-manager
npm ci
npm run build
npm start
```

ブラウザで `http://127.0.0.1:4317` を開きます。OBS では「ドック」→「カスタムブラウザドック」に同じ URL を登録してください。

OBS 側のシーン、ソース、音声トラック、プラグイン連動は [OBS_SETUP.md](docs/OBS_SETUP.md) に沿って設定します。

### 開発モード

```bash
npm install
npm run dev
```

- UI: `http://127.0.0.1:4318`
- API: `http://127.0.0.1:4317`

## YouTube / Twitch 認証

設定画面に各サービスの Client ID と Client Secret を保存し、認証ボタンを押します。

YouTube Studio では再利用可能な配信ストリームを一つ作成し、そのストリームキーを Aitum Multistream の YouTube 出力へ設定してください。本アプリは配信枠を自動作成しますが、秘密のストリームキーを API から取得して OBS 設定へ書き込むことはしません。

OAuth アプリ側には次のコールバック URL を登録してください。

```text
http://127.0.0.1:4317/api/oauth/youtube/callback
http://127.0.0.1:4317/api/oauth/twitch/callback
```

Client Secret、更新トークン、アクセストークンは設定 JSON やログには保存されません。Windows Credential Manager、macOS Keychain、Linux Secret Service のいずれかに保存されます。

## サムネイル運用

ゲーム設定で PNG／JPG／WEBP（最大4 MB）を一度登録すると、以後はゲーム選択時に同じ画像を YouTube へ自動適用します。差し替え、削除、自動適用の無効化もゲーム設定から行えます。

アップロードは一度再試行し、それでも失敗した場合は YouTube 側の前回画像を維持して配信準備を続行します。

## Steam / Game Pass

設定画面の「保存してライブラリ同期」で、Steam Web API の所有ゲームとローカルの `appmanifest_*.acf` を統合します。非公開プロフィールや API キー未設定の場合も、ローカル情報だけで同期できます。

Game Pass／Xboxゲームは安定した全件取得APIに依存せず、ゲーム設定の「Game Pass / Xbox」から手動登録します。

## 個人データと公開リポジトリ

個人用データはプロジェクト内ではなく、既定で次の OS アプリデータ領域に作成されます。

- Windows: `%APPDATA%\obs-stream-manager`
- macOS: `~/Library/Application Support/obs-stream-manager`
- Linux: `$XDG_CONFIG_HOME/obs-stream-manager`

保存対象は `config/`、`profiles/`、`thumbnails/`、`descriptions/`、`logs/`、`backups/`、`database/` です。これらの同名ディレクトリと `.env` は `.gitignore` でも除外しています。

保存先を明示する場合は `OBS_STREAM_MANAGER_DATA_DIR` を指定します。

## Stream Deck API

Stream Deck の「Webサイト」や HTTP リクエスト対応プラグインから利用できます。

```text
POST /api/select              { "gameId": "ark_survival_ascended" }
POST /api/stream/start        { "allowServiceFailures": false }
POST /api/stream/stop         {}
POST /api/replay/save         {}
POST /api/scene               { "sceneName": "30_AWAY" }
```

API は既定で `127.0.0.1` にだけバインドされ、外部ネットワークには公開されません。

## 品質チェック

```bash
npm run check
```

型検査、ESLint、Vitest、本番ビルドを順番に実行します。

## ライセンス

MIT
