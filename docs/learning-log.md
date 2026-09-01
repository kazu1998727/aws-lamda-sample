# 作業ログと学んだこと

Serverless Framework の学習用リポジトリで、これまでに何をやって何が分かったかを時系列で残しています。あとから見返して思い出すためのメモです。

## ゴール

**AWS のコストを毎日 9 時 (JST) に Slack へ通知するアプリを作る。**

そのための足がかりとして、まず「関数を作る → デプロイする → 定期実行する → 外部サービスに通知する」を順番に試しています。現在は 3 番目まで進んだところです。

---

## 1. テンプレートからの出発

`serverless create` 相当のテンプレートで生成された状態がスタート地点でした（コミット `a2bc790 init`）。

- `handler.js` に `hello` 関数がひとつだけ
- `serverless.yml` にサービス定義とプロバイダ設定

### 学んだこと

`serverless.yml` が全体の設計図で、ここに書いたものがそのまま AWS のリソースになります。

| 項目 | 設定値 | 意味 |
| --- | --- | --- |
| `service` | `sample` | AWS 上のリソース名の接頭辞になる。`sample-dev-hello` のように展開される |
| `provider.runtime` | `nodejs24.x` | Lambda の実行環境。Node.js のバージョンはここで決まる |
| `provider.architecture` | `arm64` | Graviton。x86 より安く動く |
| `provider.region` | `ap-northeast-1` | 東京リージョン。**指定しないと `us-east-1` になる** |
| `org` / `app` | `kazu1216727` / `sample` | Serverless Framework Dashboard 連携用。v4 ではアクセスキーが必要 |

---

## 2. README をこのプロジェクトの内容に更新（PR #1・マージ済み）

テンプレート由来の汎用的な README が残ったままだったので、実際の `serverless.yml` / `handler.js` の内容に合わせて書き直しました。

- テンプレート用のフロントマター（`title: 'AWS NodeJS Example'` などの HTML コメント）を削除
- org / service / ランタイム / リージョンを構成表に記載
- デプロイ・呼び出しの出力例を、汎用例（`aws-node` / `us-east-1`）から実際の値に修正
- 未コミットだった `package.json` / `package-lock.json` をリポジトリに追加

### 学んだこと

テンプレートの README は「テンプレートの説明書」であって「自分のプロジェクトの説明書」ではありません。リージョンやサービス名が実態と違うまま残っていると、あとで自分が混乱します。

---

## 3. 関数を増やす（PR #2）

`bye` と `sample` を追加し、関数が複数ある構成にしました。

```yaml
functions:
  hello:
    handler: handler.hello        # ルートの handler.js の hello を呼ぶ
  bye:
    handler: handler.bye
  sample:
    handler: ./src/handler.sample # src/handler.js の sample を呼ぶ
```

### 学んだこと

- `handler` の書式は **`ファイルパス（拡張子なし）.エクスポート名`**。`handler.hello` は「`handler.js` の `exports.hello`」という意味で、ドットの左右で意味が違います。
- ファイルを `src/` に分けても、`handler` のパスを合わせれば動きます。関数が増えてきたらファイルを分割したほうが見通しが良くなります。
- パスの `./` は他の関数の書き方（`handler.hello`）と揃っていないので、`src/handler.sample` に統一したほうが読みやすいです。デプロイ時にパス解決で失敗するようなら、まずここを疑います。

---

## 4. 定期実行の追加（作業中）

コスト通知用の関数を追加し、EventBridge のスケジュールで毎日起動するようにしました。

```yaml
  costNotification:
    handler: ./src/costNotification.handler
    events:
      - schedule:
          rate: cron(0 0 * * ? *)
          enabled: true
```

```js
// src/costNotification.js
exports.handler = async (event) => {
  console.log("event:", event);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'コスト通知です！' })
  };
}
```

詳細と次にやることは [毎日9時のSlack通知](./slack-daily-notification.md) にまとめています。

### 学んだこと（最重要）

**EventBridge の cron 式は UTC で解釈されます。** `cron(0 0 * * ? *)` は「毎日 0 時 UTC」であり、JST では **9 時**です。狙いどおりの時刻になっていますが、これは偶然ではなく UTC+9 の計算結果です。

> JST 9:00 − 9 時間 = UTC 0:00

日本時間の X 時に動かしたければ、cron には **X − 9 時（負になったら 24 を足して前日扱い）** を書きます。「JST 18 時に動かしたい」なら `cron(0 9 * * ? *)` です。

---

## つまずいたとき見るところ

| やりたいこと | コマンド |
| --- | --- |
| 手元から関数を実行する | `serverless invoke --function costNotification` |
| ローカルで実行する | `serverless dev` |
| ログ（`console.log` の出力）を見る | `serverless logs --function costNotification --tail` |
| デプロイした構成を確認する | AWS コンソール → Lambda / EventBridge |
| 作ったものを全部消す | `serverless remove` |

`console.log` の出力は CloudWatch Logs に流れます。定期実行の関数は自分で叩けないので、動いたかどうかはログで確認することになります。

## 関連

- PR #1 — README をこのプロジェクトの内容に更新（マージ済み）
- PR #2 — `sample` 関数を追加
