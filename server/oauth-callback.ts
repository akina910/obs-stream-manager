const manualCloseMessage = 'このタブを閉じて OBS Stream Manager に戻ってください。'
const automaticCloseMessage = 'このウィンドウは自動で閉じます。'

function serializeForInlineScript(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

export function youtubeOAuthCallbackHtml(openerOrigin: string): string {
  const serializedOrigin = serializeForInlineScript(openerOrigin)

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>YouTube 認証完了</title>
</head>
<body style="background:#0b0d12;color:#fff;font-family:system-ui,sans-serif;padding:40px;line-height:1.6">
  <main>
    <h1>YouTube 接続が完了しました</h1>
    <p id="oauth-status">${manualCloseMessage}</p>
  </main>
  <noscript><p>${manualCloseMessage}</p></noscript>
  <script>
    const status = document.getElementById('oauth-status');
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'oauth-complete', provider: 'youtube' }, ${serializedOrigin});
      status.textContent = ${serializeForInlineScript(automaticCloseMessage)};
      window.setTimeout(() => window.close(), 800);
    }
  </script>
</body>
</html>`
}
