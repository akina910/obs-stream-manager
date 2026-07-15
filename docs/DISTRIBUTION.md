# Windows配布ガイド

この文書の操作は配布担当者だけが行います。一般利用者へOAuthアプリ作成やClient ID設定を依頼しないでください。

## OAuthクライアント

- YouTube: GoogleのDesktop app OAuth clientを作成します。PKCEと `http://127.0.0.1:4317/api/oauth/youtube/callback` のループバックを使用する公開クライアントで、Client Secretは配布物へ含めません。
- Twitch: Device Code Flowを有効にした公開クライアントを作成します。Client Secretは使用しません。

`provider-oauth.example.json` をコピーした一時JSONか、環境変数で公開Client IDだけをビルドへ渡します。

```powershell
$env:OBS_STREAM_MANAGER_PROVIDER_OAUTH_FILE='C:\release-input\provider-oauth.json'
# または
$env:OBS_STREAM_MANAGER_YOUTUBE_CLIENT_ID='google-desktop-public-client-id'
$env:OBS_STREAM_MANAGER_TWITCH_CLIENT_ID='twitch-public-client-id'
npm ci
npm run dist:win
```

生成前処理はClient Secret、API Key、アクセストークン、更新トークンを検出すると失敗します。生成される `build/provider-oauth.json` はGit管理対象外です。

## 成果物

`release/` に次を生成します。

- `OBS Stream Manager-Setup-<version>-x64.exe`: ユーザー単位NSISインストーラー
- `OBS Stream Manager-Portable-<version>-x64.exe`: 単体Portable EXE
- `OBS Stream Manager-<version>-win.zip`: 展開して使うPortable ZIP

成果物の起動検証:

```powershell
npm run verify:package
```

この検証はNode.jsをPATHから外し、新規データ領域で起動、loopback限定待受、二重起動防止、×操作後のドック継続、非表示バックグラウンド起動、EXE再実行による画面復帰、明示終了、資格情報保存、秘密を含まないバックアップ、再起動復元を確認します。検証環境のWindows自動起動設定は変更しません。

## GitHub Actions

リポジトリ変数 `YOUTUBE_CLIENT_ID` と `TWITCH_CLIENT_ID` に公開Client IDを登録し、`Windows distribution` ワークフローを手動実行します。ワークフローは検証済み成果物をActions artifactとして保存しますが、タグ作成やGitHub Release公開は行いません。

Releaseへ添付する前に、署名、ウイルス対策ソフトでの確認、クリーンなWindows 11環境でのインストール、実アカウントOAuth、YouTube非公開配信、Twitchテスト配信を実施してください。

現行版はAitum MultistreamへのTwitch映像出力資格情報を安全に自動設定できません。OAuthだけで新規環境のYouTube／Twitch同時配信が完了することをリリース条件にする場合、この項目は未達です。Aitumを事前設定した検証環境では、OBS開始後にYouTubeとTwitchの両方が実際に `LIVE` になることを確認し、認証保存表示だけで合格にしないでください。
