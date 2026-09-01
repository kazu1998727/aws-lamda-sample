# Slack 送信の実装で ESM と CommonJS を混ぜて壊した話

2026-09-01（前記録の続き） / リポジトリ: `udemy-aws-lamda/sample` / ブランチ `feat/sample-function`

前提となる記録: [2026-09-01 コスト通知 Lambda の追加と、その周辺で踏んだ落とし穴](2026-09-01-cost-notification-lambda.md)

## 背景

前回の記録で「未対応」に挙げていた **Slack 通知の実装本体** に着手した回。
`src/costNotification.js` を、ログを出すだけのスタブから
`@slack/webhook` で実際に送信する実装に差し替えた（15:29:04）。
その直後に再パッケージが走っている（`.serverless/` が 15:29:16 に再生成）。

作業前の状態:

- `src/costNotification.js` は `console.log` して固定文字列を返すだけのスタブ
- `@slack/webhook@8.0.2` はインストール済みだが未使用
- `package.json` は npm が自動生成した最小版（`dependencies` のみ、`name` も `version` も無い）
- 前回の記録で「require を書いた瞬間に再デプロイが要る」と予告していた箇所

書かれた実装:

```js
import  { IncomingWebhook } from '@slack/webhook';

const url = process.env.SLACK_WEBHOOK_URL;
const webhook = new IncomingWebhook(url);

exports.handler = async (event) => {
  await webhook.send({
    text: "I've got news for you...",
  });
}
```

**このコードは現状デプロイしても動かない。** 以下がその詳細。

---

## 詰まった点と対処

### 1. ESM の `import` と CommonJS の `exports` が同じファイルに同居している

上のコードは1行目が ESM（`import`）、6行目が CommonJS（`exports.handler`）。
`package.json` に `"type"` フィールドが無いので `.js` は既定で CommonJS 扱いになる。

```console
$ cat package.json
{
  "dependencies": {
    "@slack/webhook": "^8.0.2"
  }
}
```

ここで **「`import` は使えないので `Cannot use import statement outside a module` で落ちる」
と予想したが、それは外れた**。Node 22.12 以降の `require(esm)` により、
Node は ESM 構文を検出してこのファイルを **ESM として読み込む**（スタックの
`loadESMFromCJS` がそれ）。その結果、落ちるのは `import` 行ではなく `exports` 行になる:

```console
$ node probe.cjs
file:///home/kazuma/src/udemy-aws-lamda/sample/src/costNotification.js:6
exports.handler = async (event) => {
^

ReferenceError: exports is not defined in ES module scope
    at file:///.../src/costNotification.js:6:1
    at ModuleJobSync.runSync (node:internal/modules/esm/module_job:665:37)
    at ModuleLoader.importSyncForRequire (node:internal/modules/esm/loader:347:47)
    at loadESMFromCJS (node:internal/modules/cjs/loader:1747:24)
```

Lambda 側が ESM として `import` する経路でも同じ:

```console
$ node --input-type=module -e "await import('.../src/costNotification.js')"
ReferenceError: exports is not defined in ES module scope
    at file:///.../src/costNotification.js:6:1
```

つまり **`handler` は最後までエクスポートされない**。
Lambda は初期化時にハンドラを解決できず失敗する。

**対処:** 未修正（「未対応」参照）。直すなら1行で、
`exports.handler = async (event) => {` を `export const handler = async (event) => {`
にするのが素直（`import` 側に揃える）。
逆に CommonJS に揃えるなら1行目を `const { IncomingWebhook } = require('@slack/webhook');` にする。

### 2. 最初の確認方法が間違っていて「問題なし」と誤判定した

これは自分の誤り。最初に `node -e` で読み込んで、正常終了したので
一度「エクスポートは壊れていない」と受け取った:

```console
$ SLACK_WEBHOOK_URL="https://example.invalid/x" node -e "
  const m = require('./src/costNotification.js');
  console.log('module keys:', Object.keys(m));
  console.log('typeof m.handler:', typeof m.handler);
"
module keys: []
typeof m.handler: undefined
full: [Module: null prototype] {  }
```

エラーは出ないが `keys: []` で `handler: undefined`。
「例外が出ない」ことと「正しく動く」ことを混同しかけた。

原因は `node -e` の実行コンテキストに **グローバルの `exports` が漏れている**こと:

```console
$ node -e "console.log('typeof exports in -e:', typeof exports)"
typeof exports in -e: object
```

そのため `exports.handler = ...` が ReferenceError にならず、
存在しないオブジェクトに代入して黙って捨てられていた。
`node -e` をやめて独立した `.cjs` ファイルから require したら、
上の 1 の通り ReferenceError が出た。

**対処:** モジュールの読み込み挙動を確かめるときは `node -e` を使わず、
実ファイルから読む。`node -e` は CJS 由来のグローバルを持ち込むため、
ESM/CJS の判定を検証する用途には**適さない**。

### 3. Webhook をモジュールのトップレベルで構築している

環境変数が無いと、ハンドラに入る前の**モジュール読み込み時点**で落ちる:

```console
$ node -e "require('./src/costNotification.js')"
Error: Incoming webhook URL is required
    at new IncomingWebhook (.../@slack/webhook/dist/IncomingWebhook.js:72:19)
    at file:///.../src/costNotification.js:4:17
```

Lambda ではこれは初期化エラーになり、リトライの都度コンテナ初期化から失敗する。
ハンドラ内で組み立てるか、少なくとも `url` の存在チェックを入れて
意図の分かるメッセージで落とすほうが後で追いやすい。

なお **これは 1 とは独立した問題**。1 を直しても環境変数未設定時の挙動はこのまま。

**対処:** 未修正。

### 4. 前回の予告どおり、パッケージの中身が入れ替わった（こちらは good）

前回「zip に `@slack/webhook` が入っていない」「serverless CLI 本体 7MB が混入している」
と書いた2点は、今回の再パッケージで両方解消していた:

```console
$ unzip -l .serverless/sample.zip | grep -c "@slack"
198
$ unzip -l .serverless/sample.zip | grep -cE "node_modules/(serverless|undici)/"
0
$ unzip -l .serverless/sample.zip | tail -3
      147  1980-01-01 00:00   src/handler.js
---------                     -------
  3030795                     367 files
```

zip は 3.6MB → 809KB、展開後 8.3MB → 3.0MB。
CLI が消えたのは前回書いた **npm の prune の副作用**であって、
今回意図的に整理したわけではない。結果的に軽くなっただけ。

CloudFormation テンプレート側の定義は前回から変わっていない:

```console
Handler: ./src/costNotification.handler
Runtime: nodejs24.x
env keys: ['SLACK_WEBHOOK_URL']
```

**なお `.serverless/` にあるのは `package` の成果物であり、
AWS へのアップロードまで完了したかはローカルからは判断できない。未確認。**
仮に完了していれば、上記 1 により初期化時エラーになるはず（実行ログは未確認）。

---

## 学び

- **`package.json` に `"type"` が無くても、Node 22.12+ は `import` を含む `.js` を
  ESM として読み込む。** 古い知識のまま
  「`Cannot use import statement outside a module` が出るはず」と身構えると、
  実際に出るエラー（`exports is not defined in ES module scope`）と結びつかず遠回りする。
  エラーは `import` 行ではなく `exports` 行で出る。

- **`import` と `exports` を1ファイルに混ぜない。** どちらかに揃える。
  混在は構文エラーにならず、ハンドラが黙って未エクスポートになるという
  分かりにくい壊れ方をする。

- **`node -e` はモジュール形式の検証に使ってはいけない。**
  CJS 由来のグローバル `exports` が漏れているため、ESM なら落ちるコードが通ってしまう。
  検証は独立したファイル（`.cjs` / `.mjs`）から行う。

- **「例外が出ない」を「正しい」と読み替えない。**
  今回は `Object.keys(m)` が空、`typeof handler` が `undefined` という形で
  出力に答えが書いてあったのに、終了コードだけ見て一度流しかけた。

- **外部サービスのクライアントをモジュールのトップレベルで構築すると、
  設定不備がハンドラ実行前の初期化エラーになる。** 原因が分かりにくくなるので、
  ハンドラ内で組むか、明示的な事前チェックを置く。

- **前回の記録の「未対応」は、次回の作業でそのまま踏む。**
  今回踏んだのはまさに前回書いた「require を書いた瞬間に壊れる」箇所だった。
  未対応リストは読み返す価値がある。

---

## 未対応

- ~~**ESM/CJS 混在の修正そのもの。**~~ → 記録直後に ESM 側へ寄せて対応した。下の「追記」を参照。

- **Webhook 構築位置と環境変数チェック。** 上記 3。ESM/CJS を直す際に併せて判断したい。

- **`send()` の戻り値とエラー処理。** 現在の `handler` は `await webhook.send(...)` するだけで、
  戻り値も返さず、失敗時の扱いも無い。スケジュール実行なので戻り値自体は不要だが、
  失敗時にリトライさせたいのかどうかは決めていない。

- **通知内容が固定文字列（`"I've got news for you..."`）のまま。**
  Cost Explorer からの実費用取得は未着手。前回から変わらず。

- **デプロイが AWS 側で完了したかの確認。** `serverless deploy --stage dev` の
  実行結果も CloudWatch Logs も見ていない。上記 1 がある以上、
  先に修正してから確認するほうが手戻りが少ないと判断した。

- **`package.json` の整備。** `name` / `version` が無い自動生成のまま。
  ESM に寄せるなら `"type": "module"` をここに足す判断も絡むので、
  モジュール形式の方針が決まるまで触らない。

---

## 追記: ESM に統一して解消（同日）

上の 1 と 2 は、この記録を書いた直後に修正した。CommonJS ではなく **ESM 側に寄せた**。

- `package.json` に `"type": "module"` を追加
- `src/costNotification.js`: `exports.handler` → `export const handler`
- `handler.js`: `exports.hello` / `exports.bye` → `export const`
- `src/handler.js`: `exports.sample` → `export const`

**`handler.js` と `src/handler.js` まで直したのは巻き添えを避けるため。**
`"type": "module"` はディレクトリ配下の `.js` すべてに効くので、
`costNotification.js` だけ直して他を CommonJS のまま残すと、
今度は hello / bye / sample が同じ `exports is not defined in ES module scope` で落ちる。
**「片方を直すともう片方が壊れる」構造**であり、ここが分割できない理由。

`costNotification.js` だけ `.mjs` にして他を CJS のまま残す案もあったが、
混在が残って後から読む人が迷うため採らなかった。

検証:

```console
$ node --input-type=module -e "..."
costNotification: [ 'handler' ] handler: function
handler.js: [ 'bye', 'hello' ] hello: function bye: function
src/handler.js: [ 'sample' ] sample: function
--- invoke hello ---
{ statusCode: 200, body: '{"message":"こんにちは！"}' }

$ serverless package
✔ Service packaged (3s)
```

`@slack/webhook` は CommonJS のパッケージだが、
`import { IncomingWebhook } from '@slack/webhook'` の名前付きインポートは
Node 側が解決できている（cjs-module-lexer による named export 検出）。
**CJS パッケージすべてで名前付きインポートが通るわけではない**点は注意。

### 追記時点でも残っていること

- **トップレベルでの Webhook 構築**（上の 3）は直していない。
  `SLACK_WEBHOOK_URL` 未設定時にモジュール読み込みで落ちる挙動はそのまま。
- **デプロイは未実施。** `serverless package` までしか実行していない。
  AWS 上の関数は依然として壊れた版のはず（**未確認**）。
