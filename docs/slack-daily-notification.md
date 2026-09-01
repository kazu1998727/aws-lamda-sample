# 毎日9時のSlack通知

AWS のコストを毎日 9 時 (JST) に Slack へ通知する、という目標に向けた設計メモです。「今どこまでできていて、次に何が必要か」を残しています。

## 全体像

```
EventBridge (毎日 0:00 UTC = 9:00 JST)
   ↓ 起動
Lambda: costNotification
   ↓ ① コストを取得        （未実装）
Cost Explorer API
   ↓ ② メッセージを組み立てて POST（未実装）
Slack Incoming Webhook
```

現在は **「時間が来たら Lambda が起動する」ところまで**が動いています。①と②はこれからです。

---

## 今できていること：スケジュール起動

```yaml
  costNotification:
    handler: ./src/costNotification.handler
    events:
      - schedule:
          rate: cron(0 0 * * ? *)
          enabled: true
```

### cron 式の読み方

EventBridge の cron は **6 フィールド**で、Linux の cron（5 フィールド）とは形が違います。

```
cron(分 時 日 月 曜日 年)
cron(0  0  *  *  ?   *)
```

- `?` は「指定しない」の意味。**日と曜日はどちらか一方を `?` にする必要があります**（両方 `*` にするとエラー）。
- 上の式は「毎日 0 時 0 分 (UTC)」。

### タイムゾーンの罠

**cron 式は UTC で解釈されます。** ここが一番間違えやすいところです。

| 動かしたい時刻 (JST) | 書く cron 式 |
| --- | --- |
| 9:00 | `cron(0 0 * * ? *)` ← 今これ |
| 12:00 | `cron(0 3 * * ? *)` |
| 18:00 | `cron(0 9 * * ? *)` |
| 8:00 | `cron(0 23 * * ? *)`（UTC では前日の 23 時） |

計算式は **UTC = JST − 9**。負になったら 24 を足します。

> 補足：新しい EventBridge Scheduler にはタイムゾーン指定の機能があります。Serverless Framework の `schedule` イベントから使えるかはバージョン次第なので、必要になったら公式ドキュメントで確認してください。UTC で計算して書けば確実に動きます。

### `rate` と `cron` の使い分け

`schedule` の書き方には 2 種類あります。

- `rate: rate(1 day)` — 「〜おきに」。デプロイした時刻が起点になるので、**時刻は指定できません**。
- `rate: cron(0 0 * * ? *)` — 「決まった時刻に」。今回のように「毎日 9 時」と決めたいときはこちら。

キー名が両方 `rate` なのが紛らわしいですが、値が `cron(...)` なら cron として扱われます。

### `enabled: true`

ルールの有効・無効です。`false` にするとデプロイはされるが起動しなくなります。開発中に毎日勝手に動いてほしくないときに使えます。

---

## これから必要なこと

### ① Slack Incoming Webhook の準備

1. Slack アプリを作成し、Incoming Webhook を有効化して、通知先チャンネルの Webhook URL を発行する
2. その URL を **コードに直接書かない**（リポジトリに入れるとアウト）

URL の渡し方は環境変数経由にします。

```yaml
provider:
  environment:
    SLACK_WEBHOOK_URL: ${env:SLACK_WEBHOOK_URL}
```

`.env` を使う場合は `.gitignore` に追加すること。より丁寧にやるなら AWS Systems Manager Parameter Store に置いて `${ssm:/sample/slack-webhook-url}` で参照する方法もあります。

### ② Slack への送信

`nodejs24.x` なら `fetch` がグローバルで使えるので、追加のライブラリは不要です。

```js
await fetch(process.env.SLACK_WEBHOOK_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '今日のコストは ○○ 円です' })
});
```

### ③ コストの取得（Cost Explorer API）

- 使う API は `ce:GetCostAndUsage`
- **Cost Explorer API のエンドポイントは `us-east-1` のみ**です。Lambda 自体は東京リージョンでも、SDK のクライアントには `region: 'us-east-1'` を指定する必要があります。ここも引っかかりやすいポイント。
- Lambda の実行ロールに権限を足す必要があります。

```yaml
provider:
  iam:
    role:
      statements:
        - Effect: Allow
          Action:
            - ce:GetCostAndUsage
          Resource: '*'
```

### ④ タイムアウトの見直し

Serverless Framework のデフォルトのタイムアウトは 6 秒です。外部 API を 2 つ叩くようになったら足りなくなる可能性があるので、必要なら伸ばします。

```yaml
  costNotification:
    timeout: 30
```

---

## 動作確認のしかた

定期実行の関数は「9 時まで待つ」わけにいかないので、手で叩いて確認します。

```
serverless invoke --function costNotification          # デプロイ済みの関数を実行
serverless logs --function costNotification --tail     # ログを流しっぱなしで見る
```

スケジュールが実際に登録されているかは、AWS コンソールの EventBridge → ルール から確認できます。

## 気づいたこと

現在の `costNotification` は `statusCode` と `body` を返していますが、**EventBridge から起動される関数では戻り値は誰にも読まれません**。`statusCode` は API Gateway 経由で HTTP レスポンスを返すときの形式なので、この関数では返さなくても問題ありません。既存の `hello` / `bye` をコピーした名残です。

実装が進んだら、戻り値よりも「失敗したときにどう気づくか」（ログ、エラー時の Slack 通知など）のほうが重要になります。

## 関連

- [作業ログと学んだこと](./learning-log.md)
