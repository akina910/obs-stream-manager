# Windows配布ガイド

この文書の操作は配布担当者だけが行います。一般利用者にGoogle Cloud、Twitch Developer Console、Client ID、Client Secret、環境変数、コマンド操作を要求してはいけません。

## OAuthプロバイダー設定

### YouTube

Google CloudでDesktop app OAuthクライアントを作成し、ダウンロードしたJSONをリポジトリ外のアクセス制限された場所へ保存します。YouTube接続はPKCE付きAuthorization Code Flowを使います。

GoogleがDesktop appクライアントに発行する `client_secret` はインストール済みアプリ内で秘匿できる認証要素ではありませんが、Googleのトークンエンドポイントへ渡す必要があります。実行時はWindows資格情報マネージャーへ取り込み、通常設定、バックアップ、ログへは保存しません。実値をソース、Issue、Pull Request、READMEへ記載しないでください。

### Twitch

Device Code Flowを有効にした公開クライアントを作成します。Twitch Client Secretは使用も配布もしません。

## ローカル配布ビルド

GoogleからダウンロードしたJSONをそのまま一時入力として使用できます。

```powershell
$env:OBS_STREAM_MANAGER_GOOGLE_CLIENT_JSON='C:\release-input\google-desktop-client.json'
$env:OBS_STREAM_MANAGER_TWITCH_CLIENT_ID='twitch-public-client-id'
npm ci
npm run oauth:configure
```

配布成果物を生成するときは、JSONの値をプロセス環境へ読み込みます。値をコンソールへ表示しないでください。

```powershell
$google = Get-Content -LiteralPath 'C:\release-input\google-desktop-client.json' -Raw | ConvertFrom-Json
$env:OBS_STREAM_MANAGER_YOUTUBE_CLIENT_ID = $google.installed.client_id
$env:OBS_STREAM_MANAGER_YOUTUBE_CLIENT_SECRET = $google.installed.client_secret
$env:OBS_STREAM_MANAGER_YOUTUBE_CLIENT_TYPE = 'desktop'
$env:OBS_STREAM_MANAGER_TWITCH_CLIENT_ID = 'twitch-public-client-id'
npm run dist:win
```

`provider-oauth.example.json` をコピーしたリポジトリ外の一時JSONを `OBS_STREAM_MANAGER_PROVIDER_OAUTH_FILE` で指定する方法も利用できます。生成される `build/provider-oauth.json` と `release/` はGit管理対象外です。

生成前処理は次の場合に失敗します。

- YouTubeクライアント種別が `desktop` ではない
- YouTube Desktop appクライアント資格情報が不足している
- Twitch Client Secret、API Key、アクセストークン、更新トークンが入力に含まれる

## 成果物

- `OBS Stream Manager-Setup-<version>-x64.exe`: ユーザー単位NSISインストーラー
- `OBS Stream Manager-Portable-<version>-x64.exe`: インストール不要のPortable EXE
- `OBS Stream Manager-<version>-win.zip`: 展開して使うPortable ZIP

成果物の起動検証:

```powershell
npm run verify:package
```

この検証はNode.jsをPATHから外した状態、新規データ領域、loopback限定待受、二重起動防止、終了時プロセス停止、設定復元、秘密情報を含まないバックアップ、同梱OBSプラグインの存在を確認します。

## GitHub Actions

次をGitHubリポジトリへ登録して `Windows distribution` ワークフローを手動実行します。

- Repository variable `YOUTUBE_CLIENT_ID`: Google Desktop app Client ID
- Repository secret `YOUTUBE_CLIENT_SECRET`: Google Desktop appクライアント資格情報
- Repository variable `TWITCH_CLIENT_ID`: Twitch公開Client ID

ワークフローは検証済み成果物をActions artifactとして保存しますが、タグ作成やGitHub Release公開は行いません。

Releaseへ添付する前に、署名、ウイルス対策ソフトでの確認、クリーンなWindows 11環境でのインストール、実アカウントOAuth、YouTube非公開配信、Twitchテスト配信を実施してください。認証表示だけではライブ配信検証の代用になりません。

ワークフローはOBS Stream Manager Outputプラグインもビルドして配布物へ同梱します。新規環境ではアプリを一度起動してプラグインを自動配置し、OBS再起動後にTwitchの非公開帯域テストとYouTube／Twitch同時配信を確認してください。配信キーは通常設定や成果物へ書き出されません。
