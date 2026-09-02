# sample — Serverless Framework AWS Lambda 練習用プロジェクト

Serverless Framework (v4) を使って Node.js の関数を AWS Lambda にデプロイする学習用サンプルです。イベント定義や永続化 (データベース) は含まれておらず、`serverless invoke` から直接呼び出すだけのシンプルな構成になっています。

## 構成

| 項目 | 値 |
| --- | --- |
| org | `kazu1216727` |
| app / service | `sample` |
| プロバイダ | AWS |
| ランタイム | `nodejs24.x` |
| アーキテクチャ | `arm64` |
| リージョン | `ap-northeast-1` (東京) |

### ファイル

- [handler.js](handler.js) — Lambda 関数の実装
- [serverless.yml](serverless.yml) — サービス・プロバイダ・関数の定義

### 関数

| 関数名 | ハンドラ | レスポンス |
| --- | --- | --- |
| `hello` | [handler.hello](handler.js#L1) | `{"message":"こんにちは！"}` |
| `bye` | [handler.bye](handler.js#L10) | `{"message":"さよなら！"}` |

いずれも `statusCode: 200` と JSON 文字列の `body` を返します。

## 使い方

### 準備

```
npm install
```

デプロイには AWS の認証情報と、`serverless.yml` の `org` に対応する Serverless Framework のアクセスキーが必要です。

### デプロイ

```
serverless deploy
```

実行すると次のような出力になります。

```
Deploying "sample" to stage "dev" (ap-northeast-1)

✔ Service deployed to stack sample-dev (90s)

functions:
  hello: sample-dev-hello (1.5 kB)
  bye: sample-dev-bye (1.5 kB)
```

### 呼び出し

デプロイ後、次のコマンドで関数を実行できます。

```
serverless invoke --function hello
serverless invoke --function bye
```

`hello` の結果は次のようになります。

```json
{
  "statusCode": 200,
  "body": "{\"message\":\"こんにちは！\"}"
}
```

### ローカル開発

```
serverless dev
```

AWS Lambda のローカルエミュレータが起動し、リクエストが AWS Lambda との間でトンネリングされます。クラウド上で動かしているのと同じ感覚で関数を呼び出せるため、再デプロイなしにコードを書き換えて結果をすぐ確認できます。

開発が終わったら `serverless deploy` でクラウドへ反映してください。

When you are done developing, don't forget to run `serverless deploy` to deploy the function to the cloud.

## 作業記録

- [2026-09-01 コスト通知 Lambda の追加と、その周辺で踏んだ落とし穴](docs/2026-09-01-cost-notification-lambda.md)
  — `${ssm:...}` が秘密を隠さない件、`package.json` 無しの `npm install` が
  `node_modules` を刈る件、デプロイ zip への CLI 混入。
- [2026-09-01 Slack 送信の実装で ESM と CommonJS を混ぜて壊した話](docs/2026-09-01-slack-webhook-esm-cjs.md)
  — `import` と `exports` の混在でハンドラが未エクスポートになる件、
  `node -e` がモジュール形式の検証に使えない件。
- [2026-09-01 aws-sdk v2 から v3 への移行と、`invoke local` の ERR_MODULE_NOT_FOUND](docs/2026-09-01-aws-sdk-v3-esbuild.md)
  — `AWS is not defined` の正体、Serverless v4 の esbuild が `.js` では既定で走らない件、
  古いバックアップで編集中のファイルを上書きした失敗。
- [2026-09-02 HTTP API に throttling を入れた理由と、それが CloudFormation に残らない件](docs/2026-09-02-api-gateway-throttling.md)
  — API Gateway の既定上限がアカウント上限と同値な件、プラグインが CFN ではなく
  デプロイ後の API 直叩きで設定する件、スロットル時に 429 ではなく 503 が返った件。

> なお、この README 上部は Serverless の公式テンプレートのままで、
> サービス名・リージョン・関数一覧が実態とずれています。詳細は上記の作業記録を参照。
