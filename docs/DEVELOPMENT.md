# 開発ガイド

この文書は開発者向けです。一般利用者はNode.jsや以下のコマンドを必要としません。

## 必要環境

- Node.js 22以上
- npm
- Windows配布物を作る場合はWindows 11 x64

```powershell
git clone https://github.com/akina910/obs-stream-manager.git
cd obs-stream-manager
npm ci
npm run dev
```

- UI開発サーバー: `http://127.0.0.1:4318`
- API／OBSドック: `http://127.0.0.1:4317`

## 品質チェック

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run check` で上記をまとめて実行できます。配布ランタイムの検証はWindowsで次を実行します。

```powershell
npm run dist:win:dir
npm run verify:package
```

検証は一時データ領域と専用の資格情報サービス名を使用し、実利用中の設定や認証情報を変更しません。

## ローカルサーバー

Fastifyサーバーは常に `127.0.0.1` のみにバインドします。既定ポートは4317です。個人データの既定保存先は `%APPDATA%\obs-stream-manager` で、`OBS_STREAM_MANAGER_DATA_DIR` はテストや開発時の上書きにだけ使います。

秘密情報は `server/secrets.ts` を経由してOS資格情報ストアへ保存します。通常設定、ログ、バックアップへ追加しないでください。
