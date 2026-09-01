# コスト通知 Lambda の追加と、その周辺で踏んだ落とし穴

2026-09-01 / リポジトリ: `udemy-aws-lamda/sample` / ブランチ `feat/sample-function`

> **この文書の性質について**
> 本文は作業後にリポジトリの成果物（`git` 履歴、`.serverless/` の生成物、
> `node_modules` とファイルの mtime）から再構成したものです。
> 会話ログは残っていないため、「誰がいつ何を打ったか」は一部推定です。
> 推定箇所には明示的に「未確認」と書きます。

## 背景

Serverless Framework v4 の AWS Node.js テンプレートに、
定期実行の `costNotification` 関数を足そうとしていた。

作業開始時点の状態:

- `serverless.yml` に `hello` / `bye`（`handler.js`）と `sample`（`src/handler.js`）が定義済み
- 直前のコミットは `79d6a9d feat: sample関数を追加`
- provider は `nodejs24.x` / `arm64` / `ap-northeast-1`
- `.gitignore` は `node_modules` と `.serverless` の2行のみ
- **`package.json` は存在しなかった**（`git show --stat a2bc790` の通り、init コミットは
  `.gitignore` / `README.md` / `handler.js` / `serverless.yml` の4ファイルのみ）

やったこと:

- `src/costNotification.js` を新規作成
- `serverless.yml` に `costNotification` を追加（EventBridge スケジュール + SSM 由来の環境変数）
- `serverless deploy` を実行（`.serverless/` の生成物が 15:22 に更新されている）
- `@slack/webhook` を npm install（15:23）

```yaml
  costNotification:
    handler: ./src/costNotification.handler
    events:
      - schedule:
          rate: cron(0 0 * * ? *)
          enabled: true
    environment:
      SLACK_WEBHOOK_URL: ${ssm:udemy-aws-lamda-slack-webhook}
```

---

## 詰まった点と対処

### 1. `${ssm:...}` は「秘密のまま Lambda に渡す」仕組みではない

`SLACK_WEBHOOK_URL: ${ssm:udemy-aws-lamda-slack-webhook}` と書けば
Webhook URL が隠蔽されるつもりでいた。実際は **デプロイ時にローカルで解決され、
平文のまま CloudFormation テンプレートと Lambda の環境変数に焼き込まれる**。

生成物を見ると値がそのまま入っている（値自体はここには貼らない）:

```console
$ grep -o 'SLACK_WEBHOOK_URL[^,]*' .serverless/cloudformation-template-update-stack.json
SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/T0AP.....
```

つまり `${ssm:...}` が防いでいるのは「**リポジトリに秘密をコミットすること**」だけで、
以下には平文で残る:

- `.serverless/cloudformation-template-update-stack.json`（ローカル）
- `.serverless/serverless-state.json`（ローカル）
- デプロイ済み CloudFormation スタックのテンプレート（AWS 上）
- Lambda の環境変数（`lambda:GetFunctionConfiguration` 権限があれば誰でも読める）

**対処:** `.gitignore` に `.serverless` が入っていたためコミット流出は起きていない
（`git status --porcelain` に `.serverless` は現れない）。
ただし AWS 側の露出はそのまま。対応は「未対応」節を参照。

秘密を本当に隠したいなら、環境変数には SSM の**パラメータ名**だけを渡し、
関数実行時に SDK で取得する（`${ssm:...}` は使わない）形にする必要がある。
なお SecureString を使った場合の挙動は今回試しておらず**未確認**。

### 2. `package.json` の無い場所で `npm install` すると、既存の node_modules が刈られる

`@slack/webhook` を入れた結果、生成された `package.json` はこれだけだった:

```console
$ cat package.json
{
  "dependencies": {
    "@slack/webhook": "^8.0.2"
  }
}
```

`name` も `version` も無い。npm が最小構成を自動生成したもの。
問題はその副作用で、**`package.json` に列挙されていない既存パッケージが
extraneous として削除される**。実際 `node_modules/.bin` は空になった:

```console
$ ls node_modules/.bin/
（空）

$ ls -a node_modules/
.  ..  .bin  .package-lock.json  @slack  @types  p-retry  retry  undici-types
```

デプロイ時の zip には `node_modules/serverless` が入っていたので、
インストール前はローカルに serverless CLI が居たことが分かる:

```console
$ unzip -l .serverless/sample.zip | grep -cE "node_modules/(serverless|undici)/"
182
```

これが npm install で消えた。今回 `serverless deploy` が壊れなかったのは
mise 側にグローバル版があったからで、たまたま助かっただけ:

```console
$ which serverless
/home/kazuma/.local/share/mise/installs/node/24.20.0/bin/serverless
$ npx --no-install serverless --version
Serverless ϟ Framework 4.41.1
```

なお `package.json` / `package-lock.json` の作成時刻は 15:23:27 で、
会話開始時の `git status` スナップショットには写っていない。
**誰の操作で作られたかは未確認**（別ターミナルでの手動実行の可能性が高い）。

**対処:** 現時点では未対処。両ファイルとも未追跡のまま。

### 3. デプロイ zip に serverless CLI 本体（7MB の amd64 バイナリ）が混入していた

`package.patterns` を書いていないため `node_modules` が丸ごと同梱される。
ハンドラ4本が合計 600 バイト程度なのに、zip は 3.6MB / 展開後 8.3MB:

```console
$ unzip -l .serverless/sample.zip | head -8
  Length      Date    Time    Name
      284  1980-01-01 00:00   handler.js
      105  1980-01-01 00:00   node_modules/.bin/serverless
      105  1980-01-01 00:00   node_modules/.bin/sls
      915  1980-01-01 00:00   node_modules/.package-lock.json
     6938  1980-01-01 00:00   node_modules/serverless/binary.js
  7049378  1980-01-01 00:00   node_modules/serverless/node_modules/.bin/serverless-linux-amd64-0.0.2
```

provider は `arm64` なので、この **amd64 バイナリは実行され得ない完全な死荷重**。
`undici` の Markdown ドキュメント群も同様に入っていた。

**対処:** 未対処。

### 4. デプロイ済みの成果物には `@slack/webhook` が入っていない

順序の問題。deploy が 15:22、npm install が 15:23 だったため、
zip に Slack SDK は含まれていない:

```console
$ unzip -l .serverless/sample.zip | grep -c "@slack"
0
```

`src/costNotification.js` は現状 SDK を `require` していないので今は動くが、
実装を進めて `require("@slack/webhook")` を書いた瞬間、
再デプロイしない限り `MODULE_NOT_FOUND` になる。

```js
exports.handler = async (event) => {
  console.log("event:", event);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'コスト通知です！' })
  };
}
```

**対処:** 未対処。Slack 送信の実装と同時に再デプロイが要る。

### 5. cron はローカル時刻ではない

`cron(0 0 * * ? *)` は **UTC 0時 = JST 9時**。日本時間の深夜0時のつもりなら誤り。
EventBridge のスケジュール式にタイムゾーン指定は無い（`cron()` は常に UTC）。

```console
$ python3 -c "..." # CFテンプレートより
EventsRule: {"ScheduleExpression": "cron(0 0 * * ? *)", "State": "ENABLED", ...}
```

今回は「毎日1回コスト通知」なので JST 9時でもむしろ都合が良く、意図的にそのままにした。
ただし **これが意図した時刻だったのか、UTC を失念していたのかは未確認**。

### 6. README の記述とリポジトリの実態がずれている

`README.md` は Serverless の公式テンプレートのままで、以下が実態と食い違う:

- 「The deployed function does not include any event definitions」
  → 実際には EventBridge スケジュールを持つ関数がある
- デプロイ例のサービス名が `aws-node` / リージョン `us-east-1`
  → 実際は `sample` / `ap-northeast-1`
- `serverless invoke --function hello` しか案内が無い
  → `bye` / `sample` / `costNotification` がある

**対処:** 今回は README を書き換えず、ズレている事実をこの文書に残すに留めた。
テンプレート由来の説明文を消すか残すかは判断保留（「未対応」参照）。

---

## 学び

- **`${ssm:...}` は「コミットしない」ための仕組みであって「隠す」ための仕組みではない。**
  デプロイ時に解決され、CloudFormation テンプレートと Lambda 環境変数に平文で残る。
  秘密を実行時まで隠したいなら、環境変数にはパラメータ名を渡して関数内で SDK 取得する。

- **`package.json` の無いディレクトリで `npm install <pkg>` を打たない。**
  npm は最小の `package.json` を自動生成し、そこに載っていない既存パッケージを
  extraneous として削除する。先に `npm init -y` を済ませておく。

- **`node_modules` に開発ツール（CLI 等）が同居している状態で
  `package.patterns` 無しにデプロイしない。** ツール本体ごと zip に入る。
  クロスアーキテクチャのバイナリは実行されないぶん、気づかないまま太り続ける。

- **依存を足した直後は再デプロイが要る。** 「ローカルで npm install した」と
  「Lambda のパッケージにその依存が入っている」は別の話。
  今回のように deploy → install の順だと、次に require を書いた時点で初めて壊れる。

- **EventBridge の `cron()` は常に UTC。** ローカル時刻のつもりで書かない。

- **生成物（`.serverless/`）は事後の調査に強い。** CF テンプレート・state・zip の中身を
  読めば、何がどう解決されて何が同梱されたかが確定的に分かる。
  記憶や手順書より、生成物を先に見る。

---

## 未対応

- **Slack 通知の実装本体。** `src/costNotification.js` は今もログ出力と
  固定文字列を返すだけ。`@slack/webhook` は入れたが未使用。
  AWS Cost Explorer からの費用取得も未着手。

- **Webhook URL の AWS 上での露出。** Lambda 環境変数と CloudFormation テンプレートに
  平文で残っている。ローカルの `.serverless/` にも残る。
  学習用リポジトリであり、漏洩時の影響は Slack への書き込みに限られると判断して保留。
  気になるなら Slack 側で Webhook を再発行するのが早い。

- **`package.json` / `package-lock.json` をコミットするかの判断。**
  現在どちらも未追跡。`name` / `version` すら無い自動生成物なので、
  整えてからコミットするか、そもそも `serverless` をローカル依存に戻すかを含めて保留。

- **`package.patterns` によるデプロイパッケージの削減。** 効果は明らかだが、
  除外を書き間違えると必要な依存まで落ちる。Slack 実装が入って
  「何が本当に必要か」が確定してから手を入れる。

- **`node_modules/.bin` が空になった件の復旧。** グローバルの serverless で
  動いてしまっているため実害が出ていない。ローカル依存に戻すかは
  上記 `package.json` の方針と併せて決める。

- **README の更新。** ズレは把握したが未修正。テンプレート由来の説明を
  どこまで残すか決めていない。
