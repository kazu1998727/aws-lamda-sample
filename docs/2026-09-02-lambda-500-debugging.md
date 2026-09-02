# 2026-09-02 `{"message":"Internal Server Error"}` を「繋がらない」と読み違えた話

## 背景

同じ日の [throttling 対応](2026-09-02-api-gateway-throttling.md) の続きで、
DynamoDB に書き込む `POST /tasks` を追加していた。前提となっていた状態は次のとおり。

- `src/taskHandler.js`（新規・未追跡）… `@aws-sdk/client-dynamodb` の `PutItemCommand` で1件書く
- `serverless.yml` に追記済み
  - `taskPost` 関数（`httpApi` の `POST /tasks`）
  - **関数レベルの** `iamRoleStatements` で `dynamodb:PutItem` を `table/tasks` に許可
  - `resources.Resources` に `AWS::DynamoDB::Table`（`TableName: tasks`）
- すでに `serverless deploy` 済み
- `package.json` に `@aws-sdk/client-dynamodb` 追加済み

この状態で curl したら 500 が返る、というのが出発点。

```
$ curl -X POST -H 'Content-type: application/json' --data '{"text":"Hello, World!"}' \
    https://1k0kj1zukd.execute-api.ap-northeast-1.amazonaws.com/tasks
{"message":"Internal Server Error"}
```

「なぜ繋がらないの？」という問いだったが、**繋がっていないわけではなかった**。

## 詰まった点と対処

### 1. `Internal Server Error` は接続の問題ではない。まずそこを切り分ける

「繋がらない」に引っ張られる前に、到達しているかどうかを確認した。ルートも関数も存在した。

```
$ aws apigatewayv2 get-routes --api-id 1k0kj1zukd --region ap-northeast-1 \
    --query 'Items[].{Key:RouteKey,Target:Target}' --output json
[
    { "Key": "POST /tasks", "Target": "integrations/9rbkg5o" },
    { "Key": "GET /hello",  "Target": "integrations/yos5be9" }
]

$ aws lambda list-functions --region ap-northeast-1 \
    --query 'Functions[?starts_with(FunctionName,`sample-dev`)].FunctionName' --output json
[ "sample-dev-helloWorld", "sample-dev-costNotification", "sample-dev-sample",
  "sample-dev-taskPost", "sample-dev-bye", "sample-dev-hello" ]
```

つまりリクエストは Lambda まで届いていて、そこで例外が出ている。
**API Gateway の Lambda プロキシ統合は、Lambda が投げた例外の中身をクライアントに出さない。**
一律で 500 と `{"message":"Internal Server Error"}` になる。原因は CloudWatch Logs にしかない。

DNS も TLS も経路も疑う必要はなかった。ここを最初に確定させるかどうかで調査の向きが変わる。

### 2. 送っていたフィールド名が違った（1つ目の実エラー）

```
$ aws logs tail /aws/lambda/sample-dev-taskPost --region ap-northeast-1 --since 2h --format short
2026-09-02T05:28:13 ERROR Invoke Error {"errorType":"ValidationException",
"errorMessage":"Supplied AttributeValue is empty, must contain exactly one of the supported datatypes",
... "at async post (/src/taskHandler.js:19:3)"}
```

ハンドラは `requestBody.title` を読んでいるのに、送っていたのは `{"text":"Hello, World!"}` だった。
`title` が `undefined` になり、`{ S: undefined }` という空の AttributeValue が DynamoDB に渡って弾かれた。

注目すべきは、**JavaScript 側は最後まで何も言わない**こと。`undefined` を値に持つオブジェクトは
普通に作れてしまい、AWS に送られて初めてサーバ側の validation で落ちる。
手元のコードを読んでいるだけでは気づけない種類のバグで、ログを見るまで分からない。

### 3. テーブル名の大文字小文字。しかも `ResourceNotFound` ではなく `AccessDenied` が返った

`title` を付けて投げ直したら、エラーの種類が変わった。

```
2026-09-02T05:30:28 ERROR Invoke Error {"errorType":"AccessDeniedException",
"errorMessage":"User: arn:aws:sts::293298314142:assumed-role/sample-dev-taskPost-ap-northeast-1-lambdaRole/sample-dev-taskPost
is not authorized to perform: dynamodb:PutItem on resource:
arn:aws:dynamodb:ap-northeast-1:293298314142:table/Tasks
because no identity-based policy allows the dynamodb:PutItem action"}
```

コードは `TableName: "Tasks"`（大文字 T）、`serverless.yml` が作ったテーブルは `tasks`（小文字）。

```
$ aws dynamodb list-tables --region ap-northeast-1
{ "TableNames": [ ..., "tasks" ] }

$ aws dynamodb describe-table --table-name Tasks --region ap-northeast-1
An error occurred (ResourceNotFoundException) when calling the DescribeTable operation:
Requested resource not found: Table: Tasks not found
```

**DynamoDB のテーブル名は大文字小文字を区別する。**

ここが今回いちばん紛らわしかった。`Tasks` は**存在しない**のに、返ってきたのは
`ResourceNotFoundException` ではなく `AccessDeniedException` だった。
IAM が `table/tasks` にしか許可を出していないので、**リソースの存在確認より先に認可で落ちる**。

エラー文だけ読むと「IAM の書き方が悪い」に見える。実際にはポリシーは正しく、
コード側のテーブル名がタイプミスだった。ここで IAM をいじり始めると、
正しいポリシーを壊しながら遠回りすることになる。

対処は `TableName` を `"tasks"` に直して再デプロイ（ユーザーが実施）。
IAM は既に `table/tasks` を許可済みだったので、他に変更は要らなかった。

```
$ curl -s -X POST -H 'Content-type: application/json' --data '{"title":"hello-task"}' \
    https://1k0kj1zukd.execute-api.ap-northeast-1.amazonaws.com/tasks -w "\nHTTP %{http_code}\n"
{"message":"Task created successfully"}
HTTP 200

$ aws dynamodb scan --table-name tasks --region ap-northeast-1 \
    --query 'Items[].{id:id.S,title:title.S}' --output table
--------------------------------------------------------
|                  id                   |    title     |
+---------------------------------------+--------------+
|  3d1ac8e0-803e-43d4-a688-e8631c85b87d |  hello-task  |
```

### 4. ログの整形でタイムスタンプを捨てて、「デプロイ済みコードが違う」と誤認した

3 の途中でやらかした。`title` を付けて投げた直後に、こう確認した。

```
$ aws logs tail /aws/lambda/sample-dev-taskPost --region ap-northeast-1 --since 2m --format short \
    | grep -o '"errorType":"[^"]*"\|"errorMessage":"[^"]*"' | sort -u
"errorMessage":"Supplied AttributeValue is empty, must contain exactly one of the supported datatypes"
"errorType":"ValidationException"
```

`title` を入れたのに 2 と同じエラーに見えた。そこで
**「デプロイされているコードがローカルと違うのでは」と推測し**、デプロイ済みの zip を
ダウンロードして中身まで確認しにいった。

```
$ U=$(aws lambda get-function --function-name sample-dev-taskPost --region ap-northeast-1 \
      --query 'Code.Location' --output text)
$ curl -s "$U" -o fn.zip && unzip -q fn.zip && cat src/taskHandler.cjs
...
var post = async (event) => {
  const requestBody = JSON.parse(event.body);
  const item = { id: {...}, title: { S: requestBody.title } };
  ...
  const command = new import_client_dynamodb.PutItemCommand({ TableName: "Tasks", Item: item });
```

コードはローカルと一致していた。この寄り道は完全に無駄だった。

**誤認の原因は自分のコマンドにあった。** `grep -o ... | sort -u` で整形した結果、
**タイムスタンプを捨てていた**。表示されたエラーが「いつのリクエストのものか」が分からない状態で、
一番新しいものだと思い込んでいた。実際に出ていたのは、その前に投げられていた古いリクエストのエラーで、
自分のリクエストのログはまだ配信されていなかった。

やり直しではこうした。

```
$ date -u '+now: %Y-%m-%dT%H:%M:%SZ'
now: 2026-09-02T05:31:03Z
$ curl -s -X POST ... --data '{"title":"hello-task"}'
$ sleep 8
$ aws logs tail ... --since 1m --format short | grep -E "ERROR|START|REPORT" | tail -6
2026-09-02T05:30:28 START RequestId: 287f1837-...
2026-09-02T05:30:28 ERROR Invoke Error {"errorType":"AccessDeniedException", ... table/Tasks ...}
```

タイムスタンプを残しただけで、エラーが 3 の `AccessDeniedException` に変わっていることが一目で分かった。
**エラーは既に変わっていて、前に進んでいた。**

### 5. `iamRoleStatements` について、確認できたのに確認せず誤った指摘をした

この作業の前に、`serverless.yml` の未コミット差分を見て
「関数レベルの `iamRoleStatements` は `serverless-iam-roles-per-function` プラグインの記法で、
素の Serverless Framework では効かないはず（未検証）」と伝えていた。**これは誤り。**

デプロイ済みのロールを見たら、ちゃんと反映されていた。

```
$ aws iam get-role-policy --role-name sample-dev-taskPost-ap-northeast-1-lambdaRole \
    --policy-name sample-dev-lambda --query 'PolicyDocument'
{
    "Statement": [
        { "Action": ["logs:..."], "Resource": [".../sample-dev-taskPost:*:*"], "Effect": "Allow" },
        { "Action": ["dynamodb:PutItem"], "Resource": "arn:aws:dynamodb:*:*:table/tasks", "Effect": "Allow" }
    ]
}
```

`plugins:` に入っているのは `serverless-api-gateway-throttling` だけで、`package.json` にも
per-function 系のプラグインは無い。**Serverless Framework v4 が標準で関数ごとのロールを作っていた**
（ロール名が `sample-dev-taskPost-ap-northeast-1-lambdaRole` と関数名入りになっているのがその証拠）。

「未検証」と断りは入れていたが、**確認できる材料（デプロイ済みのロール）が手元にあった**。
言う前に1コマンド打てば済んだ。

## 学び

- **「繋がらない」と「繋がった先で落ちている」を最初に切り分ける。**
  ルートと関数の存在確認は数十秒で終わる。ここを飛ばすと、経路やネットワークという
  見当違いの方向に時間を使う。
- **Lambda プロキシ統合の 500 `{"message":"Internal Server Error"}` は情報量ゼロ。**
  クライアント側には原因が一切出ない仕様なので、ログを見るまで原因の推測を始めない。
- **ログを絞るときにタイムスタンプを捨てない。**
  `grep -o` や `sort -u` で見やすくすると、そのエラーがどのリクエストのものか分からなくなる。
  「直したのに直っていない」を判定しているのは、エラー文ではなく時系列。
- **ログには配信の遅れがある。** 投げた直後に前のエラーが見えても、それが自分のリクエストとは限らない。
  リクエスト前に時刻を記録し、数秒待ってから、時刻付きで読む。
- **同じステータスコードでも、エラーの中身が変われば前進している。**
  500 が続いていても `ValidationException` → `AccessDeniedException` と変わったなら、
  1つ目は直っている。「まだ 500 だからダメ」で戻ってはいけない。
- **AWS のエラー種別は、原因の在り処を正確には示さない。**
  存在しないリソースでも、認可が先に落ちれば `AccessDenied` が返る。
  `AccessDenied` を見て IAM をいじる前に、**リソース名が実在するか**を確認する。
- **リソース名を IaC 側と実装側の2箇所にベタ書きすると、いつかズレる。**
  しかもズレたときのエラーが名前の問題に見えないことがある。
- **手元に確認できる材料があるなら、指摘する前に見る。**
  「〜のはず（未検証）」と断っても、間違った指摘は相手の時間を使う。
  断り書きは、確認を省く理由にはならない。

## 未対応

- **`title` の必須チェックを入れていない。** 未指定のまま呼ぶと、いまも DynamoDB まで行って 500 になる。
  ハンドラ側で 400 を返す方が親切だが、ユーザーの判断待ちで手を入れていない。
- **テーブル名がコードと `serverless.yml` の2箇所にベタ書きのまま。**
  環境変数で渡せば今回のズレは起きないが、変更していない。
- **動作確認で作ったテスト行（`hello-task`）がテーブルに残っている。** 消してよいか確認中。
  この記録を書いている時点で AWS の認証情報が期限切れになり、件数の再確認もできていない（**未確認**）。

  ```
  $ aws dynamodb scan --table-name tasks --region ap-northeast-1 --query 'Count'
  aws: [ERROR]: An error occurred (ValidationException) when calling the CreateOAuth2Token operation:
  The provided authorization grant is invalid, expired, revoked, or malformed
  ```

- **HTTP API のアクセスログを有効にしていない。** 有効にすれば、クライアントが受け取る
  `apigw-requestid` ヘッダから Lambda 側のログを引けるかもしれないが、**未確認**。
  今のままだと「クライアントが受け取った 500」と「CloudWatch のどのエントリ」を
  時刻でしか突き合わせられない。
- **エラー時のレスポンスに手を入れていない。** 500 のままなので、次に別の原因で落ちたときも
  同じように CloudWatch を見にいくことになる。
- **`src/taskHandler.js` と `serverless.yml` の `taskPost` / `resources` は未コミット。**
  ユーザーが作業中の変更のため、こちらでは触っていない。
