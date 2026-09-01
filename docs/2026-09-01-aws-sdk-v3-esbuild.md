# 2026-09-01 aws-sdk v2 から v3 への移行と、`invoke local` の ERR_MODULE_NOT_FOUND

## 背景

`feat/cost-notification` ブランチで、Cost Explorer から当月のコストを取得する
Lambda（`src/costNotification.js`）を書いている途中だった。前提となっていた状態は次のとおり。

- Serverless Framework 4.41.1 / `provider.runtime: nodejs24.x` / arm64 / ap-northeast-1
- `package.json` に `"type": "module"`（前回の作業で ESM に統一済み。
  [2026-09-01 Slack 送信の実装で ESM と CommonJS を混ぜて壊した話](2026-09-01-slack-webhook-esm-cjs.md) 参照）
- 依存は `aws-sdk`（v2）、`@slack/webhook`、`moment`
- ハンドラは `serverless.yml` に `handler: ./src/costNotification.handler` で登録
- Slack 送信部分はまだコメントアウトしたまま。この日の目的は Cost Explorer の呼び出しを通すこと

やろうとしていたのは「`serverless invoke local --function costNotification` を成功させる」ことだった。

## 詰まった点と対処

### 1. `ReferenceError: AWS is not defined` — v2 のグローバルは存在しない

`new AWS.CostExplorer(...)` と書いたが、ファイル先頭で `aws-sdk` を import していなかった。

```
{
    "errorMessage": "AWS is not defined",
    "errorType": "ReferenceError",
    "stackTrace": [
        "ReferenceError: AWS is not defined",
        "    at handler (/home/kazuma/src/udemy-aws-lamda/sample/.serverless/build/src/costNotification.cjs:4883:14)",
```

「Lambda なら `aws-sdk` は最初から使える」という感覚が残っていたのが原因。実際には
Node.js 16 以前のランタイムで `require('aws-sdk')` が同梱されていただけで、
`AWS` というグローバル変数はどのランタイムにも存在しない。ESM なら import は必須。

`import AWS from 'aws-sdk'` を足せば直るが、それに加えて次の2点があったので v3 へ移行した。

- **nodejs24.x のランタイムに v2 は同梱されていない。** 動かすならデプロイ zip に
  バンドルする前提になる（今回は esbuild の `bundle: true` があるので実際にバンドルされる）。
- v2 自体がメンテナンスモード。`npm install` のたびに警告が出ていた。

```
npm warn install-scripts   aws-sdk@2.1693.0 (postinstall: node scripts/warn-maintenance-mode.js)
```

移行は次のとおり。

```
npm install @aws-sdk/client-cost-explorer
npm uninstall aws-sdk
```

```
removed 45 packages, and audited 34 packages in 567ms
```

v2 の `aws-sdk` 1パッケージ（45パッケージ分の依存）が、v3 では
`@aws-sdk/client-cost-explorer` だけになった。コード側は、クライアントを
モジュールトップレベルに置き、`.promise()` をやめて `send(Command)` に書き換えた。

```js
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';

const ce = new CostExplorerClient({ region: 'us-east-1' });   // Cost Explorer は us-east-1 のみ

const data = await ce.send(new GetCostAndUsageCommand(params));
```

`params` の中身（`TimePeriod` / `Granularity` / `Metrics`）は v2 と同じで変更不要だった。

### 2. `ERR_MODULE_NOT_FOUND` は真因を隠す — esbuild が走っていなかった

v3 に書き換えた直後、`invoke local` が別のエラーで落ちた。

```
✖ Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/kazuma/src/udemy-aws-lamda/sample/src/costNotification' imported from /home/kazuma/.serverless/releases/4.41.1/package/dist/sf-core.js
Did you mean to import "/home/kazuma/src/udemy-aws-lamda/sample/src/costNotification.js"?
```

「拡張子が足りない」と読めるので、最初は **ハンドラの書き方が悪いのだと誤認した**。
具体的には `./src/costNotification.handler` の `./` 接頭辞か、export 名が
`handler` であることを疑った。これは**どちらも外れ**だった。`serverless.yml` に
検証用の関数を一時的に足して切り分けた結果が次のとおり。

| 検証 | handler | ファイル内の import | 結果 |
|---|---|---|---|
| t1 | `./src/tmpA.handler` | なし | 成功 |
| t2 | `./src/tmpA.sample` | なし | 成功 |
| t3 | `src/tmpA.handler`（`./` 無し） | なし | 成功 |
| t4 | `./src/tmpCost.sample` | `@slack/webhook`, `moment` | **同じエラーで失敗** |

つまり `./` の有無も export 名も無関係で、**ファイルが import 文を含むかどうか**が分岐点だった。
（既存の `hello` / `sample` が動いていたのは、依存を import していない単純な関数だったから。
「今まで動いていたのだから設定は正しいはず」という前提が、この時点で崩れた。）

真因は `--debug` を付けると出てくる。

```
s: Build property not set using default checking behavior for esbuild
...
      "isEsbuildEnabled": false,
```

Serverless v4 は通常ハンドラを esbuild で `.serverless/build/src/*.cjs` にバンドルしてから
読み込む。それが走らないと素の `.js` を拡張子なしのパスで import しようとして、上のエラーになる。
`build` プロパティ未設定時の既定挙動は、バンドル本体
（`~/.serverless/releases/4.41.1/package/dist/sf-core.js`）の `WillEsBuildRun` にある。

```js
if (configFile.build?.esbuild) return true;
let handlerPath = stripHandlerExportSuffix(functionHandler), parsedExtension;
for (let extension2 of ['.js','.ts','.cjs','.mjs','.cts','.mts','.jsx','.tsx'])
  if (existsSync4(path71.join(serviceDir, handlerPath + extension2))) { parsedExtension = extension2; break; }
return !!(parsedExtension && ['.ts','.cts','.mts','.tsx'].includes(parsedExtension));
```

読み取れるのは2点。**`build.esbuild` が明示されていれば無条件で走る。明示が無い場合、
ハンドラが TypeScript のときだけ走り、`.js` では走らない。** JS プロジェクトで
外部パッケージを import するなら、`build.esbuild` の明示が事実上必須ということになる。

対処は `serverless.yml` への明示。

```yaml
build:
  esbuild:
    bundle: true
    format: cjs
    outExtension:
      '.js': '.cjs'
```

これで `invoke local` が通った。

```
Cost data: {
  "ResultsByTime": [
    {
      "TimePeriod": { "Start": "2026-09-01", "End": "2026-10-01" },
      "Total": { "UnblendedCost": { "Amount": "0", "Unit": "USD" } },
      "Groups": [],
      "Estimated": true
    }
  ],
```

### 3. 作業中のファイルを、古いバックアップで上書きして壊した

上の `build.esbuild` 設定は、実は調査の途中で一度 `serverless.yml` に入っていた。
検証用関数 t1〜t4 を追記する前に `cp serverless.yml <scratch>/serverless.yml.bak` を取り、
検証後にその bak で戻したのだが、**bak を取ってから戻すまでの間に設定が追加されていた**ため、
戻した時点で消えてしまった。その後の `invoke local` が
`Build property not set` になっていたのは、これが理由と考えられる。

（`.serverless/build/src/costNotification.cjs` のタイムスタンプが 16:23 で、
私が bak を取った時刻より後だったことが状況証拠。ただし編集の正確な時刻は記録していないので
**この因果関係は未確認**。）

同じことをするなら、`cp` によるバックアップと復元ではなく、
`git stash` / `git checkout -- <file>` のように、他人の編集を巻き込まない方法を使うべきだった。
そもそも検証用の関数は、本番の `serverless.yml` ではなく別ファイルに書きたかった。
`--config serverless-test.yml` を試したが、5分待っても応答が返らずタイムアウトした。

```
npx serverless --config serverless-test.yml invoke local -f t1
# → Exit code 143 (Command timed out after 5m 0s)
```

`--config` を使うと止まる理由は**未確認**。今回は本体を直接編集する方に倒したが、
そこで上書き事故を起こしたので、判断としては失敗だった。

### 4. zsh で `*` を含むコマンドが実行前に落ちる

3回踏んだ。zsh は glob がマッチしないとコマンドを実行せずにエラーにする（bash と違う挙動）。

```
ls *.yml *.yaml
# (eval):1: no matches found: *.yaml

SLS_DEBUG=* npx serverless invoke local --function costNotification --debug
# (eval):4: no matches found: SLS_DEBUG=*

grep -rn "..." --include=*.js .
# (eval):2: no matches found: --include=*.js
```

`*` を含む引数はクォートする（`--include='*.js'`、`SLS_DEBUG='*'`）。
なお Serverless v4 では `SLS_DEBUG` 環境変数ではなく `--debug` フラグを使う。

## 学び

- **`invoke local` の `ERR_MODULE_NOT_FOUND: Cannot find module <拡張子なしのパス>` は、
  ハンドラのパス指定ミスではなく「esbuild が走っていない」サイン**。
  まず `--debug` を付けて `isEsbuildEnabled` を確認する。エラーメッセージの
  `Did you mean to import "....js"?` に引っ張られると、無関係なパス表記を延々いじることになる。
- **Serverless v4 の esbuild は、設定を明示しない限り TypeScript のときしか走らない。**
  JS + 外部パッケージの構成なら `build.esbuild` を書く。書かないと
  「依存を import しない関数だけ動く」という紛らわしい状態になる。
- 「今まで動いていた関数がある」は、設定が正しい証拠にならない。
  動いている関数と動かない関数の**差分**を最小のケースで作って比べる方が早い。
- 他人（や自分の別セッション）が編集中のファイルを、時間の経った `cp` バックアップで
  復元しない。復元は git 経由で行う。
- AWS SDK の移行では `.promise()` の有無だけでなく、**そのクライアントがどのリージョンでしか
  動かないか**も一緒に確認する。Cost Explorer は us-east-1 固定で、`provider.region` とは別。

## 未対応

- **Cost Explorer の IAM 権限を付けていない。** `serverless.yml` に `provider.iam` の
  記述が無く、`ce:GetCostAndUsage` を許可していない。ローカル実行は手元の
  AWS 認証情報（アカウント 293298314142 / default プロファイル）で動いたので気づきにくいが、
  **デプロイすると `AccessDeniedException` で落ちるはず**（デプロイ未実施のため未確認）。
- **Slack 送信が未実装のまま。** `webhook.send(...)` はコメントアウトされたままで、
  取得したコストを整形して通知する部分は書いていない。今回の目的は
  Cost Explorer の呼び出しを通すところまでと決めたため。
- **デプロイして実際のスケジュール実行を確認していない。** 確認したのは `invoke local` のみ。
- `import moment from 'moment/moment'` という deep import を残した。
  `'moment'` で足りるはずだが、動いているものを触ると切り分けが増えるので今回は変更しなかった。
- `--config <別ファイル>` で `invoke local` がハングする件は未調査。
