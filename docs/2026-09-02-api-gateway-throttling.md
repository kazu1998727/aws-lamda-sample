# 2026-09-02 HTTP API に throttling を入れた理由と、それが CloudFormation に残らない件

## 背景

`sample` サービスに、初めて外から叩ける HTTP エンドポイントを足した日。前提となっていた状態は次のとおり。

- Serverless Framework 4.41.1 / `nodejs24.x` / arm64 / ap-northeast-1
- `build.esbuild` は設定済み（[2026-09-01 aws-sdk v2 から v3 への移行](2026-09-01-aws-sdk-v3-esbuild.md) 参照）
- 既存の関数はすべて**外から叩けない**構成だった
  - `hello` / `bye` / `sample` … イベント定義なし。`serverless invoke` 専用
  - `costNotification` … `schedule` イベント（cron）のみ
- つまりこの時点で、このサービスに API Gateway のリソースは1つも存在しなかった

この日やったのは次の2つ。

1. `src/hello.js` を追加し、`serverless.yml` に `httpApi` イベントで `GET /hello` を生やす
2. その公開エンドポイントに throttling をかける

2 が本題。1 をやった瞬間に「認証なしで誰でも叩ける URL」が1本増えるので、その前提を先に潰しておきたかった。

```yml
  helloWorld:
    handler: ./src/hello.handler
    events:
      - httpApi:
          method: get
          path: /hello
```

## なぜ throttling を入れたか

### API Gateway の「既定の上限」は、実質的に上限として機能しない

API Gateway はデプロイした時点で throttling が有効になっている。ただしその既定値は
**10,000 requests/second / burst 5,000** で、これは**アカウントのリージョン単位の上限と同じ値**。
つまり、

- 個々のメソッドに実効的な上限がかかっていない
- リージョン内の全 API がひとつの枠を共有している
- 1つのメソッドが叩かれると、同じリージョンの**他の API まで巻き添えで枯渇する**

これは使ったプラグインの README が "Why?" として挙げている理由そのもの。

```
When you deploy an API to API Gateway, throttling is enabled by default. However, the default
method limits – 10,000 requests/second with a burst of 5000 concurrent requests – match your
account level limits. As a result, ALL your APIs in the entire region share a rate limit that
can be exhausted by a single method.
```
（`node_modules/serverless-api-gateway-throttling/README.md`）

### 学習用アカウントで、課金の入口を無防備に開けたくなかった

`GET /hello` には認証がない。叩かれた回数だけ Lambda が起動し、そのぶん課金される。
前日にこのリポジトリで [コスト通知 Lambda](2026-09-01-cost-notification-lambda.md) を作ったばかりだが、
あれは **事後**（1日1回 Cost Explorer を見て Slack に流す）の仕組みで、事故が起きたことを教えてくれるだけ。
流量そのものを止めるのは throttling の役目で、両者は代替関係にない。

### 入れたもの

```
npm i serverless-api-gateway-throttling
```

```yml
plugins:
  - serverless-api-gateway-throttling

custom:
  apiGatewayThrottling:
    maxRequestsPerSecond: 10
    maxConcurrentRequests: 5
```

`package-lock.json` に入った依存は `lodash.get` と `lodash.isempty` の2つ。
なお `lodash.get` は npm 上で deprecated になっている。

```json
"node_modules/lodash.get": {
  "version": "4.4.2",
  "deprecated": "This package is deprecated. Use the optional chaining (?.) operator instead.",
```

## 詰まった点と対処

### 1. Serverless Framework 本体に、`httpApi` の throttling 設定が無い

`provider.httpApi` にも `functions[].events[].httpApi` にも throttling を書く場所がない。
実際、`serverless.yml` から生成された CloudFormation テンプレートのステージ定義には
`DetailedMetricsEnabled` しか入っていなかった。

```
$ python3 -c "..." # .serverless/cloudformation-template-update-stack.json の ApiGatewayV2 リソースを表示

HttpApiStage {"Type": "AWS::ApiGatewayV2::Stage", "Properties": {"ApiId": {"Ref": "HttpApi"},
"StageName": "$default", "AutoDeploy": true,
"DefaultRouteSettings": {"DetailedMetricsEnabled": false}}}
```

`AWS::ApiGatewayV2::Stage` の `DefaultRouteSettings` は本来
`ThrottlingRateLimit` / `ThrottlingBurstLimit` を持てるのに、Serverless からは指定できない。
だからプラグインを使うことになった。

### 2. プラグインは CloudFormation に書かない。デプロイ**後**に API を直接叩いている

これが今回いちばん誤解しかけたところ。デプロイ後に CFN テンプレートを grep しても
throttling の文字列が出てこないので、一瞬「設定が効いていない」と思った。実際には効いている。

プラグインのフック定義を読むと、テンプレートに手を入れるのは **Outputs だけ**で、
throttling 本体は `after:aws:deploy:finalize:cleanup`、つまり**デプロイが全部終わったあと**に
AWS API を直接呼んで設定している。

```js
this.hooks = {
  'before:package:initialize': this.createSettings.bind(this),
  'before:package:finalize': this.updateCloudFormationTemplate.bind(this),
  'after:aws:deploy:finalize:cleanup': this.updateStage.bind(this),
  ...
};
```
（`src/apiGatewayThrottlingPlugin.js`）

```js
serverless.cli.log(`[serverless-api-gateway-throttling] Updating API Gateway HTTP API throttling settings...`);
await serverless.providers.aws.request('ApiGatewayV2', 'updateStage', params, { region });
```
（`src/updateHttpApiStageThrottling.js`）

CFN テンプレートに入るのは、あとで Stage を探すための API ID の Output だけ。

```json
"HttpApiIdForApigThrottling": {
 "Description": "HTTP API ID",
 "Value": { "Ref": "HttpApi" },
 "Export": { "Name": "sls-sample-dev-HttpApiIdForApigThrottling" }
}
```

**帰結として、この設定は CloudFormation 管理外にある。** スタックのドリフトとして扱う必要がある。
毎回のデプロイ後にプラグインが付け直すので通常は元に戻るが、
このフックを通らない経路（`serverless deploy function` など）では付け直されないはず（**未確認**、フック名からの推測）。

**確認は CFN ではなく実物を見る。** これが正しい確認方法だった。

```
$ aws apigatewayv2 get-stages --api-id 1k0kj1zukd --region ap-northeast-1
{
    "Items": [
        {
            "AutoDeploy": true,
            "DefaultRouteSettings": {
                "DetailedMetricsEnabled": false,
                "ThrottlingBurstLimit": 5,
                "ThrottlingRateLimit": 10.0
            },
            "LastDeploymentStatusMessage": "Successfully deployed stage with deployment ID 'r72mcp'",
            "LastUpdatedDate": "2026-09-02T03:13:00+00:00",
            "RouteSettings": {
                "GET /hello": {
                    "ThrottlingBurstLimit": 5,
                    "ThrottlingRateLimit": 10.0
                }
            },
            "StageName": "$default",
            ...
```

`LastUpdatedDate` が 03:13:00 UTC（= 12:13:00 JST）で、`npx serverless deploy` を叩いた
12:12:26 JST の直後。デプロイの一部ではなく、デプロイ後の追加操作として入っていることが時刻からも読める。

もう1点。この `updateStage` はデプロイ実行者の AWS 認証情報で呼ばれるので、
**デプロイする側の IAM に API Gateway のステージ更新権限が要る**。
Lambda 実行ロール（`provider.iam` に書いた `ce:GetCostAndUsage` のほう）とは別物。
今回は手元の管理者権限で通ったので気づかずに済んだ。

### 3. `maxConcurrentRequests` は「同時実行数」ではなく burst

設定名を素直に読むと「同時に5リクエストまで」と解釈してしまうが、違う。
プラグインが AWS に送る直前のマッピングを見ると対応関係がはっきりする。

```js
const createRouteSettingsForStage = (settings) => {
    return {
        ThrottlingBurstLimit: settings.maxConcurrentRequests,
        ThrottlingRateLimit: settings.maxRequestsPerSecond
    }
}
```
（`src/updateHttpApiStageThrottling.js`）

`maxConcurrentRequests` → `ThrottlingBurstLimit`。API Gateway の throttling はトークンバケットで、
`ThrottlingRateLimit` がバケツへの補充レート、`ThrottlingBurstLimit` がバケツの容量。
「10 rps を1リクエストでも超えたら即落ちる」のではなく、**バケツに溜まっている5個分までは瞬間的に吸収される**。
同時接続数の話ではない。

### 4. エンドポイント個別の設定を書いていないのに、`RouteSettings` が付いた

上の `get-stages` の出力で、`DefaultRouteSettings` だけでなく `RouteSettings` にも
`GET /hello` が入っている。`serverless.yml` にはエンドポイント個別の `throttling:` を書いていないのに、である。

理由はプラグインの設定オブジェクトの作り方にあった。全 `httpApi` イベントを列挙して、
個別指定が無ければグローバル値で埋める。

```js
for (let event of functionSettings.events) {
  ...
  if (isHttpApiEndpoint(event)) {
    this.httpApiEndpointSettings.push(new ApiGatewayEndpointThrottlingSettings(functionName, event, 'httpApi', this))
  }
}
```

```js
this.maxRequestsPerSecond = get(event[eventType].throttling, 'maxRequestsPerSecond', globalSettings.maxRequestsPerSecond);
this.maxConcurrentRequests = get(event[eventType].throttling, 'maxConcurrentRequests', globalSettings.maxConcurrentRequests);
```
（`src/ApiGatewayThrottlingSettings.js`）

動作としてはステージ既定と同値が入るだけなので今は害がない。問題は消すときで、
**`serverless.yml` からエンドポイントを削除しても、ステージに残ったルート設定は消えない**
（プラグインは追加しかしない）。

プラグインには `sls reset-all-endpoint-settings` というコマンドがあるが、これは REST API 専用で、
HTTP API しかない構成では何もせず戻る。

```js
async resetEndpointSettings() {
  ...
  this.thereIsARestApi = await restApiExists(this.serverless, this.settings);
  if (!this.thereIsARestApi) {
    this.serverless.cli.log('[serverless-api-gateway-throttling] No Rest API found. Command will be ignored.');
    return;
  }
```
（`src/apiGatewayThrottlingPlugin.js`）

つまり今回の構成では、残ったルート設定を消す手段はプラグイン側に無い。

### 5. スロットルされたレスポンスは 429 ではなく 503 だった

設定が効いているか実際に叩いて確かめた。想定していたのは `429 Too Many Requests` だったが、返ってきたのは 503。

```
$ for i in $(seq 1 30); do curl -s -o /dev/null -w "%{http_code}\n" \
    https://1k0kj1zukd.execute-api.ap-northeast-1.amazonaws.com/hello & done; wait
503
200
200
200
503
200
...
```

ボディとヘッダも確認した。

```
$ curl -s -D - https://1k0kj1zukd.execute-api.ap-northeast-1.amazonaws.com/hello
HTTP/2 503
date: Wed, 02 Sep 2026 03:16:19 GMT
content-type: application/json
content-length: 33
apigw-requestid: DDQ4kg70tjMEM-A=

{"message":"Service Unavailable"}
```

`x-amzn-errortype` のようなヘッダは付かない。**なぜ 429 ではなく 503 なのかは未確認。**
クライアント側で「429 を見て backoff する」実装をしていたら、これは拾えない。

もうひとつ、検証のしかたで引っかかった点。同じ25並列でも、`curl -D -` でヘッダを標準出力に
出す版では**全部 200 になった**。

```
$ for i in $(seq 1 25); do curl -s -D - -o /dev/null .../hello | grep -iE "^HTTP/" & done; wait
     25 HTTP/2 200
```

パイプと grep のぶんだけリクエストの発射が散って、10 rps + burst 5 のバケツを超えなかったため。
60並列まで上げると再現した。

```
$ for i in $(seq 1 60); do curl -s -D $S/d_$i.txt -o /dev/null .../hello & done; wait
     53 HTTP/2 200
      7 HTTP/2 503
```

throttling の検証で効くのは**並列数ではなく到着レート**で、シェルの `&` は発射レートを保証しない。

## 学び

- **「既定で上限が設定されている」は「上限が守ってくれる」を意味しない。**
  既定値がアカウント上限と同じなら、それは実質的に上限が無いのと同じで、
  さらにリージョン内の他の API と枠を共有している。マネージドサービスの既定値は、
  「安全な値」ではなく「上限の最大値」が入っていることがある。
- **公開エンドポイントを1本足すのは、課金の入口を1本開けること。**
  事後に気づく仕組み（コスト通知）と、事前に止める仕組み（throttling）は別物で、片方は片方の代わりにならない。
- **プラグインが「どこに」書くかを確認する。** CFN テンプレートに出ないなら、
  それは API 直叩きで、CloudFormation 管理外＝ドリフトする前提の設定。
  設定できたかどうかの確認は、テンプレートではなく実物（`aws ... get-stages`）で行う。
- **設定項目名を意味で読まない。** `maxConcurrentRequests` → `ThrottlingBurstLimit` のように、
  名前と実体がずれていることがある。プラグイン経由なら、AWS に送る直前のマッピングを読むのが確実。
- **プラグインは「追加」はしても「削除」はしないことがある。**
  設定を消したときに実物からも消えるかは、入れる前に確認しておくと後で困らない。
- **エラー時のステータスコードは想定せず実測する。** 今回は 429 のつもりが 503 だった。
  リトライやアラートの条件をコードに書く前に、実際のレスポンスを見る。
- **レート制限の検証は「並列数」ではなく「到着レート」で決まる。**
  `&` で並べただけでは発射レートは制御できず、再現しないことがある。

## 未対応

- **503 が返る理由を調べていない。** API Gateway の HTTP API がスロットル時に 503 を返す条件も、
  429 が返るケースがあるのかも未確認。
- **残留するルート設定の消し方を確認していない。** 4 のとおりプラグインには手段が無いので、
  `aws apigatewayv2 update-stage` で直接消すことになるはずだが、試していない。
- **10 rps / 5 burst という値に根拠がない。** 想定利用パターンから見積もったものではなく、
  学習用として意図的に低くしただけ。実運用ならメトリクスを見て決める必要がある。
- **認証をつけていない。** throttling は流量の上限であって、アクセス制御ではない。
  `GET /hello` は誰でも叩ける状態のまま。
- **CloudWatch アラームも使用量プラン（API キー）も WAF も未検討。** 今回は throttling だけ。
- **エンドポイント個別の `throttling:` 設定は使っていない。** ステージ既定のみ。
- `serverless.yml` のプラグイン行と設定値の行末に半角スペースが残っている。動作には影響しないが未整理。
- `src/handler.js` の差分は今回の作業と無関係（クォートと末尾カンマの整形のみ）。
- **コード側の変更（`serverless.yml` / `package.json` / `src/hello.js`）は未コミット。**
  このブランチにはこのドキュメントと README の追記しか入れていない。
