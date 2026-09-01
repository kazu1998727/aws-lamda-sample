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

### 削除

作成した AWS リソースをまとめて削除するには次を実行します。

```
serverless remove
```

## 参考

- [Serverless Framework ドキュメント](https://www.serverless.com/framework/docs/providers/aws/events/)
- [Serverless Examples リポジトリ](https://github.com/serverless/examples/)
