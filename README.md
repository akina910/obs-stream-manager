# OBS Stream Manager

[日本語](README.md) | [English](README.en.md)

ゲーム選択、OBS操作、YouTube／Twitchの配信設定を一つのOBSブラウザドックにまとめるWindowsアプリです。配布用アプリでは、利用者にNode.js、npm、コマンド操作、Client ID入力、開発者登録を求めません。アプリ内の表示言語は日本語と英語から選べます。

> [!WARNING]
> 現在は開発中です。動作保証や個別サポートはありません。公開GitHub Releaseはまだありません。本番前にYouTubeの非公開配信とTwitchのテスト配信で確認してください。

## 現在の配布状況

- Windows 11 x64向けのインストーラー、Portable EXE、Portable ZIPを再現可能に生成できます。
- 現在の検証用パッケージは [Windows distributionワークフロー](https://github.com/akina910/obs-stream-manager/actions/workflows/windows-distribution.yml) のActions artifactです。GitHubへのサインインが必要で、保存期間は14日です。
- 一般利用者向けの公開GitHub Releaseはまだ作成していません。Release公開後は、そのReleaseに添付されたファイルを利用してください。
- 現在の開発ビルドはコード署名されていないため、Windows SmartScreenが警告する場合があります。

## パッケージの違い

### インストーラー版

`OBS Stream Manager-Setup-*-x64.exe` を実行し、画面に従ってユーザー単位でインストールします。スタートメニューとデスクトップへショートカットを作成します。通常利用にはこちらを推奨します。初回起動後はWindowsログイン時に非表示で準備する設定が既定で有効になり、OBSドックをすぐ読み込めます。設定画面または通知領域のメニューから無効にできます。公開Release開始後は、設定画面から更新をダウンロードして再起動できます。

### Portable EXE

`OBS Stream Manager-Portable-*-x64.exe` を任意の場所から直接起動します。インストールは不要です。移動後の壊れた自動起動登録を避けるため、Portable版はWindowsの自動起動へ登録しません。OBSを開く前にEXEを起動してください。

### Portable ZIP

`OBS Stream Manager-*-win.zip` を任意のフォルダーへ展開し、`OBS Stream Manager.exe` を起動します。配布内容を確認したい場合や、フォルダー単位で本体を管理する場合に向きます。

どの形式でも、設定と認証情報は実行ファイルの隣ではなく、Windowsの同じユーザーデータ領域へ保存されます。EXEがUIとローカルサーバーを自動起動するため、利用者がNode.jsをインストールしたり、サーバーを構築・起動したり、コマンドを実行したりする必要はありません。ローカルサーバーは `127.0.0.1` だけで待ち受け、LANやインターネットへ公開しません。

## OBSへドックを追加

1. OBS Stream Managerを起動します。
2. OBS Studioで「ドック」→「カスタムブラウザドック」を開きます。
3. 名前に `Stream Manager`、URLに `http://127.0.0.1:4317` を入力します。
4. 追加したドックを任意の位置へ配置します。

アプリの起動画面にも登録用URLとコピーボタンを表示します。OBS側の詳しい準備は [OBS_SETUP.md](docs/OBS_SETUP.md) を参照してください。

デスクトップ画面の×を押しても、OBSドック用サーバーは停止せず通知領域で動作を続けます。EXEをもう一度起動すると同じ画面が再表示されます。サーバーを含めて停止する場合だけ、通知領域または設定画面の「完全に終了」を選びます。完全終了後はOBSドックも停止します。

## 初期セットアップ

初回起動時はセットアップダイアログが開き、表示言語、OBSドックURL、OBS WebSocket、YouTube／Twitch認証、ゲーム検出を順番に確認できます。完了状態は保存され、次回起動時には自動で閉じます。設定画面からいつでも開き直せます。

Steamは任意です。Steamクライアントにログイン済みなら、ローカルへインストールしていない所有ゲームも含めて自動追加します。SteamIDやSteam APIキーの入力は不要です。未インストールのゲームはGeForce NOW用として登録され、ローカル導入済みかクラウド利用かを一覧で判別できます。Steamがない場合も、Game Pass、GeForce NOW、Switch、単体EXEのゲームを手動追加できます。ARKやDiabloなどの固定ゲームを初期状態へ勝手に追加しません。

## 最初の接続と配信

1. OBSの「ツール」→「WebSocketサーバー設定」でWebSocketサーバーを有効にします。
2. 初期セットアップまたは設定画面でOBS WebSocketのURLと、設定されている場合はパスワードを保存します。
3. 「YouTubeに接続」または「Twitchに接続」を押します。
4. 既定ブラウザでアカウントを選び、権限を許可します。
5. アプリへ戻り、対象サービスが「接続済み」になったことを確認します。
6. ゲーム一覧からゲームを選び、必要ならゲーム設定を編集してプロファイルを適用します。
7. 配信先ごとの実通信状態を確認してから「配信開始」を押します。

認証はYouTubeがデスクトップ向けPKCE、TwitchがDevice Code Flowです。Client ID、Client Secret、API Key、Broadcaster IDを利用者が入力する画面はありません。「配布設定エラー」が表示される場合は配布物の不備なので、利用者が開発者コンソールで設定せずIssueで報告してください。

「接続済み」はアカウント認証がWindowsへ保存された状態です。映像が実際に配信されているかは、上部に表示されるYouTube／Twitchそれぞれの実配信状態で確認してください。

> [!IMPORTANT]
> YouTube接続では配信枠、メタデータ、サムネイル、OBSへ適用する映像出力情報を管理します。Twitch接続ではタイトル、カテゴリ、タグ、コメント、配信キー、実配信状態を管理します。同梱のOBS Stream Manager Outputプラグインが、配信中だけTwitch副出力をメモリ上に生成するため、Aitum Multistreamへのキー入力は不要です。Twitchが `LIVE` になるまで同時配信成功と判断しないでください。

## 必要環境

- 対応対象: Windows 11 x64
- 対応対象: OBS Studio 31.1以上（内蔵WebSocketサーバーを有効化）
- YouTube／Twitch同時映像出力: 同梱プラグインをアプリが自動配置（初回または更新後はOBSを再起動）
- 任意: Aitum Vertical、Source Record、Advanced Scene Switcher、Steam

Aitum Multistreamは不要です。Source RecordやAitum Verticalが無い場合は、それぞれの個別録画機能だけが警告付きで無効になります。

同梱プラグインはOBS公式のWindows用プラグイン領域`C:\ProgramData\obs-studio\plugins\obs-stream-manager-output`へ配置されます。通常ユーザーで書き込めない環境では、管理者へインストール許可を依頼してください。

## 主な機能

- PC／Nintendo Switch／例外ゲームのプロファイル管理
- Steam所有ゲーム（未インストールを含む）の自動検出と一覧追加
- 選択ゲームと適用中プロファイルの明示
- OBSシーン、キャプチャ、音量、録画、リプレイの連動
- OBS実メーターを使ったゲーム別音声自動調整、ピーク保護、マイク連動ダッキング
- YouTube配信枠、タイトル、説明、公開範囲、ゲーム別サムネイルの自動適用
- Twitchタイトル、カテゴリ、タグ、配信キー、副映像出力の自動適用と非公開帯域テスト
- タイトル変数 `{game}`、`{part}`、`{date}`、`{time}`、`{datetime}` と配信成功後のPart自動更新
- YouTube／Twitchの認証状態と実配信状態の個別表示
- コメント統合表示、設定バックアップ／復元
- 日本語／英語UI

## データ、更新、アンインストール

個人設定、ゲームプロファイル、サムネイル、説明文、ログ、バックアップは `%APPDATA%\obs-stream-manager` に保存されます。アプリを更新してもこのフォルダーは維持されます。

### 手動アップデート

アプリは起動時に勝手な更新確認、ダウンロード、再起動を行いません。設定画面の「アプリの更新」または通知領域の「更新を確認」を利用者が押した時だけGitHub Releasesを確認します。

インストーラー版では「更新を確認」→「更新をダウンロード」→「再起動して更新」の順に押します。配信、録画、リプレイバッファ、YouTube／Twitchの実配信や切替処理が動いている間は、安全のため最後の適用操作を止めます。適用後もゲームプロファイル、サムネイル、設定、OAuth接続は維持されます。

Portable EXE／ZIPは実行中のファイルを自己上書きしません。最新版がある場合は固定のGitHub Releasesページを開くので、新しいPortable版を取得して置き換えてください。簡単なアプリ内更新を使う場合はインストーラー版を推奨します。

OAuthトークン、配信キー、OBSパスワードなどの秘密情報は通常設定やバックアップへ入れず、Windows資格情報マネージャーの `obs-stream-manager` サービスへ保存します。

アンインストールはWindowsの「設定」→「アプリ」→「インストールされているアプリ」から行います。再インストール時に設定を引き継げるよう、アンインストールだけでは個人データを削除しません。完全に削除する場合は、アンインストール後に `%APPDATA%\obs-stream-manager` とWindows資格情報マネージャー内の `obs-stream-manager` 項目を利用者自身で削除してください。

## Issue / Pull Request

IssueとPull Requestを歓迎します。バグ報告にはWindows、OBS、本アプリのバージョン、再現手順、秘密を除いたログを添えてください。アクセストークン、更新トークン、認証コード、Client Secret、配信キー、OBSパスワードをIssueやスクリーンショットへ貼らないでください。

## 開発者向け

開発環境の準備、テスト、Windows配布物の再現方法、配布者だけが行うOAuth公開クライアント設定は [DEVELOPMENT.md](docs/DEVELOPMENT.md) と [DISTRIBUTION.md](docs/DISTRIBUTION.md) に分離しています。

## ライセンス

[MIT](LICENSE)
