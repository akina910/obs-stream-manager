# OBS Stream Manager

ゲーム選択、OBS操作、YouTube／Twitchの配信設定を一つのOBSブラウザドックにまとめるWindowsアプリです。利用者はNode.js、npm、コマンド操作、Client ID入力、開発者登録を必要としません。

> 現在は開発中です。動作保証や個別サポートはありません。本番前にYouTubeの非公開配信とTwitchのテスト配信で確認してください。

## インストール

### インストーラー版

1. GitHub Releasesから `OBS Stream Manager-Setup-*.exe` を取得します。
2. EXEをダブルクリックし、画面に従ってインストールします。
3. スタートメニューまたはデスクトップの「OBS Stream Manager」を起動します。

### Portable版

`OBS Stream Manager-*-win.zip` を任意のフォルダーへ展開し、`OBS Stream Manager.exe` を起動します。インストールせず試す場合や、USB／別フォルダーで本体を管理する場合に向きます。設定と認証情報はPortable本体ではなく、インストーラー版と同じWindowsのユーザーデータ領域へ保存されます。

## OBSへドックを追加

1. OBS Studioを起動します。
2. 「ドック」→「カスタムブラウザドック」を開きます。
3. 名前に `Stream Manager`、URLに `http://127.0.0.1:4317` を入力します。
4. 追加したドックを任意の位置へ配置します。

アプリの起動画面にも登録用URLとコピーボタンを表示します。OBS側の詳しい準備は [OBS_SETUP.md](docs/OBS_SETUP.md) を参照してください。

## 最初の接続と配信

1. 設定画面でOBS WebSocketのパスワードを保存します。
2. 「YouTubeに接続」「Twitchに接続」を押します。
3. 既定ブラウザでアカウントを選び、権限を許可します。
4. アプリへ戻り、両サービスが「接続済み」になったことを確認します。
5. ゲームを選び、「配信開始」を押します。

認証はYouTubeがデスクトップ向けPKCE、TwitchがDevice Code Flowです。Client ID／Secret／API Key／Broadcaster IDを利用者が入力する画面はありません。「配布設定エラー」が表示される場合は配布物の不備なので、利用者が開発者コンソールで設定せずIssueで報告してください。

## 必要環境

- Windows 11 x64
- OBS Studio 30以上（内蔵WebSocketサーバーを有効化）
- Aitum Multistream（YouTube／Twitchへの複数出力に使用）
- 任意: Aitum Vertical、Source Record、Advanced Scene Switcher

Source RecordやAitum Verticalが無い場合、その個別録画機能だけが警告付きで無効になります。Node.jsは不要です。

## 主な機能

- PC／Nintendo Switch／例外ゲームのプロファイル管理
- Steamインストール済みゲームの自動検出と一覧追加
- OBSシーン、キャプチャ、音量、録画、リプレイの連動
- YouTube配信枠、タイトル、説明、公開範囲、ゲーム別サムネイルの自動適用
- Twitchタイトル、カテゴリ、タグの自動適用
- YouTube／Twitchの実配信状態を個別表示
- コメント統合表示、設定バックアップ／復元
- OAuthトークン、配信キー、OBSパスワード等のWindows資格情報マネージャー保存

## データ、更新、アンインストール

個人設定、ゲームプロファイル、サムネイル、ログは `%APPDATA%\obs-stream-manager` に保存されます。アプリを更新してもこのフォルダーは維持されます。OAuthトークン、配信キー、OBSパスワードなどの秘密情報は通常設定やバックアップへ入れず、Windows資格情報マネージャーへ保存します。

アンインストールはWindowsの「設定」→「アプリ」→「インストールされているアプリ」から行います。再インストール時に設定を引き継げるよう、アンインストールだけでは個人データを削除しません。完全に削除する場合は、アンインストール後に `%APPDATA%\obs-stream-manager` とWindows資格情報マネージャー内の `obs-stream-manager` 項目を利用者自身で削除してください。

## Issue / Pull Request

IssueとPull Requestを歓迎します。バグ報告にはWindows／OBS／本アプリのバージョン、再現手順、秘密を除いたログを添えてください。アクセストークン、更新トークン、認証コード、Client Secret、配信キー、OBSパスワード、Steam APIキーをIssueやスクリーンショットへ貼らないでください。

## 開発者向け

開発環境の準備、テスト、Windows配布物の再現方法、配布者だけが行うOAuthクライアント設定は [DEVELOPMENT.md](docs/DEVELOPMENT.md) と [DISTRIBUTION.md](docs/DISTRIBUTION.md) に分離しています。

## ライセンス

MIT
