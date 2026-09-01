<!--
title: 'AWS NodeJS Example'
description: 'This template demonstrates how to deploy a simple NodeJS function running on AWS Lambda using the Serverless Framework.'
layout: Doc
framework: v4
platform: AWS
language: nodeJS
priority: 1
authorLink: 'https://github.com/serverless'
authorName: 'Serverless, Inc.'
authorAvatar: 'https://avatars1.githubusercontent.com/u/13742415?s=200&v=4'
-->

# Serverless Framework AWS NodeJS Example

This template demonstrates how to deploy a simple NodeJS function running on AWS Lambda using the Serverless Framework. The deployed function does not include any event definitions or any kind of persistence (database). For more advanced configurations check out the [examples repo](https://github.com/serverless/examples/) which include use cases like API endpoints, workers triggered by SQS, persistence with DynamoDB, and scheduled tasks. For details about configuration of specific events, please refer to our [documentation](https://www.serverless.com/framework/docs/providers/aws/events/).

## Usage

### Deployment

In order to deploy the example, you need to run the following command:

```
serverless deploy
```

After running deploy, you should see output similar to:

```
Deploying "aws-node" to stage "dev" (us-east-1)

✔ Service deployed to stack aws-node-dev (90s)

functions:
  hello: aws-node-dev-hello (1.5 kB)
```

### Invocation

After successful deployment, you can invoke the deployed function by using the following command:

```
serverless invoke --function hello
```

Which should result in response similar to the following:

```json
{
  "statusCode": 200,
  "body": "{\"message\":\"Go Serverless v4.0! Your function executed successfully!\"}"
}
```

### Local development

The easiest way to develop and test your function is to use the Serverless Framework's `dev` command:

```
serverless dev
```

This will start a local emulator of AWS Lambda and tunnel your requests to and from AWS Lambda, allowing you to interact with your function as if it were running in the cloud.

Now you can invoke the function as before, but this time the function will be executed locally. Now you can develop your function locally, invoke it, and see the results immediately without having to re-deploy.

When you are done developing, don't forget to run `serverless deploy` to deploy the function to the cloud.

## 作業記録

- [2026-09-01 コスト通知 Lambda の追加と、その周辺で踏んだ落とし穴](docs/2026-09-01-cost-notification-lambda.md)
  — `${ssm:...}` が秘密を隠さない件、`package.json` 無しの `npm install` が
  `node_modules` を刈る件、デプロイ zip への CLI 混入。
- [2026-09-01 Slack 送信の実装で ESM と CommonJS を混ぜて壊した話](docs/2026-09-01-slack-webhook-esm-cjs.md)
  — `import` と `exports` の混在でハンドラが未エクスポートになる件、
  `node -e` がモジュール形式の検証に使えない件。

> なお、この README 上部は Serverless の公式テンプレートのままで、
> サービス名・リージョン・関数一覧が実態とずれています。詳細は上記の作業記録を参照。
