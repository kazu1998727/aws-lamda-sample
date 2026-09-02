# 2026-09-02 変更セットが固まる前に PR を作って本文がズレた件と、`gh pr edit` が落ちる件

## 背景

同じ日の [HTTP API の throttling 導入](2026-09-02-api-gateway-throttling.md) の作業記録を書き、
それを別ブランチで PR にするところ。前提となっていた状態は次のとおり。

- 作業ツリーには**未コミットのコード変更**が残っていた
  （`serverless.yml` / `package.json` / `package-lock.json` / `src/handler.js` と、未追跡の `src/hello.js`）
- ドキュメントを書くにあたり、ブランチ `docs/api-gateway-throttling` を切った
- `gh` は 2.46.0（Ubuntu パッケージ版）
- リポジトリ `kazu1998727/aws-lamda-sample`、デフォルトブランチ `main`

最初の判断はこうだった。**ドキュメントと README だけをコミットし、コード変更は作業ツリーに残す。**
根拠は「コミットは明示的に頼まれたときだけ行う」という原則。
そのうえで PR を作り、本文に「ドキュメントのみの変更です。コード側は未コミットのままで、
この PR には含めていません」と明記した。

そのあとユーザーから「未コミットも一緒にコミットして」という指示があり、同じブランチに
コードの変更を3コミット追加した。ここから話がおかしくなる。

## 詰まった点と対処

### 1. PR を先に作ってしまい、本文が diff を否定する状態でマージされた

実測のタイムライン（コミットの committer date と GitHub API の `created_at` / `merged_at`）。

```
$ git log --format='%h %cI %s' origin/main -5
4da85df 2026-09-02T12:23:43+09:00 Merge pull request #6 from kazu1998727/docs/api-gateway-throttling
2660528 2026-09-02T12:23:24+09:00 docs: 未コミット扱いの記述を実態に合わせて修正
dcda39b 2026-09-02T12:23:07+09:00 style: src/handler.js を整形
b7bb94e 2026-09-02T12:23:01+09:00 feat: GET /hello を公開し、API Gateway に throttling を設定
2e939f7 2026-09-02T12:19:11+09:00 docs: HTTP API の throttling 導入の作業記録を追加
```

```
$ gh api repos/kazu1998727/aws-lamda-sample/pulls/6 --jq '...'
created: 2026-09-02T03:21:50Z   # = 12:21:50 JST
merged:  2026-09-02T03:23:43Z   # = 12:23:43 JST
merged_by: kazu1998727
commits: 4
```

並べるとこうなる。

| 時刻 (JST) | 出来事 |
| --- | --- |
| 12:19:11 | ドキュメントをコミット（この時点のブランチは docs のみ） |
| 12:21:50 | **PR #6 を作成**。本文に「ドキュメントのみの変更です」と記載 |
| 12:23:01〜12:23:24 | コードの変更を3コミット追加 |
| 12:23:43 | push、そして**マージ** |

PR 作成からマージまで **1分53秒**。本文を書き換える暇はなかった。
結果、マージされた diff は7ファイル 382行で、`serverless.yml` も `src/hello.js` も含まれているのに、
PR 本文には「この PR には含めていません」と書いてある、という状態になった。

```
$ git show --stat --oneline origin/main | head
4da85df Merge pull request #6 from kazu1998727/docs/api-gateway-throttling

 README.md                                 |   3 +
 docs/2026-09-02-api-gateway-throttling.md | 327 ++++++++++++++++++++++++++++++
 package-lock.json                         |  26 ++-
 package.json                              |   3 +-
 serverless.yml                            |  14 ++
 src/handler.js                            |   6 +-
 src/hello.js                              |   8 +
```

タイトルも `docs:` のままで、実際には `feat:` のコミットを含んでいる。

**本当の対処は「変更セットが固まるまで PR を作らない」だった。** 本文を直そうとしたが、次でつまずいた。

### 2. `gh pr edit` が GraphQL エラーで落ちる。しかもマージとは無関係だった

本文とタイトルを差し替えようとしたら失敗した。

```
$ gh pr edit 6 --title "..." --body "$(cat <<'EOF' ... EOF)"
GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience,
see: https://github.blog/changelog/2024-05-23-sunset-notice-projects-classic/. (repository.pullRequest.projectCards)
```

このとき **「PR がすでにマージされていたので編集できなかった」と誤認して、そうユーザーに報告した。
これは誤りだった。** エラー文は Projects (classic) の廃止について言っており、マージには一言も触れていない。
直前にマージされたことを確認していたので、時系列が近いというだけで因果を作ってしまった。

切り分けは、**状態を変えずに同じ操作を再実行する**ことでできた。マージ済みのまま、
現在と同じタイトルを渡す no-op な編集を投げた。

```
$ gh --version
gh version 2.46.0 (2026-06-18 Ubuntu 2.46.0-4ubuntu0.26.04.1~esm1)

$ gh pr edit 6 --title "docs: HTTP API に throttling を入れた理由と、その過程で誤認した点を記録"
GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience,
see: https://github.blog/changelog/2024-05-23-sunset-notice-projects-classic/. (repository.pullRequest.projectCards)
exit=1
```

内容を1文字も変えない操作でも同じエラー。つまり**マージ状態とは無関係**で、
`gh pr edit` がメタデータ取得時に投げる GraphQL クエリに、GitHub 側で廃止された
`projectCards` フィールドが含まれているのが原因。要するに `gh` が古い。

対処は REST API を直接叩くこと。こちらは通った。

```
$ gh api -X PATCH repos/kazu1998727/aws-lamda-sample/pulls/6 \
    -f title="docs: HTTP API に throttling を入れた理由と、その過程で誤認した点を記録" \
    --jq '"ok: title=\(.title) state=\(.state) merged=\(.merged)"'
ok: title=docs: HTTP API に throttling を入れた理由と、その過程で誤認した点を記録 state=closed merged=true
exit=0
```

`merged=true` の PR に対して成功している。**マージ済み PR のタイトル・本文は編集できる。**
できなかったのは `gh pr edit` の問題であって、マージのせいではなかった。

なお非対称で、**同じ `gh` で `gh pr create` は成功している**（PR #6 はこれで作った）。
`gh pr view` も動く。落ちるのは `pr edit` だけだった。
なぜ create と view は落ちないのかまでは**未確認**。

### 3. 「頼まれたことだけやる」を機械的に当てて、中身の薄い PR を出した

コードを未コミットのままにした最初の判断の根拠は「コミットは明示的に頼まれたときだけ」で、
原則そのものは妥当だと思う。問題は当て方だった。

「別ブランチでまとめて」という指示は、ブランチを作る＝何かをコミットする、を含んでいる。
そこでドキュメントだけを切り出した結果、**ドキュメントが説明している対象（コード）が
そのブランチに存在しない**という PR になった。読む側からは、書かれていることを diff で確認できない。

判断を保留すること自体は良い。まずいのは、**保留したまま PR という完成物を出してしまった**こと。
保留するなら PR の手前で止めて確認すべきだった。実際、そのあと「一緒にコミットして」と言われて
やり直しになっている。

## 学び

- **PR は変更セットが確定してから作る。** 途中で作れば本文は必ず古くなる。
  コミットと違って、PR 本文はブランチを push しても自動では追随しない。
- **PR 本文に書く「〜は含まれていません」は、その時点のスナップショットに対する断定。**
  あとから内容が増えると、本文が diff を否定する状態になる。
  範囲を断定する文を書いたなら、マージ前にもう一度見に行く。
- **push したら、その足で本文を直す。** レビューやマージは想定より早く来る。
  今回は PR 作成からマージまで2分弱だった。「あとで直す」は間に合わないことがある。
- **ツールの失敗を、直前の状態変化のせいにしない。** 時系列が近いだけで因果とは限らない。
  切り分けは、**状態を変えずに同じ操作をもう一度投げる**のが確実。
  no-op な操作で同じエラーが出れば、状態変化は原因ではない。
- **エラー文が言っていないことを原因にしない。** 今回のエラー文は Projects (classic) の廃止しか
  言っていなかった。読めば分かることを、状況から推測して上書きしていた。
- **`gh` のサブコマンドが GraphQL エラーで落ちたら、REST で同じことができないか試す。**
  `gh` は GraphQL 依存が強く、GitHub 側のスキーマ変更に追随できていない箇所がある。
  `gh api -X PATCH repos/OWNER/REPO/pulls/N -f body=...` は迂回路になる。
  同じ `gh` でも壊れているのは一部のサブコマンドだけ、ということがある。
- **原則を機械的に当てると成果物が中途半端になることがある。**
  「頼まれていないことはしない」は、頼まれた範囲だけで意味のある成果物になるかを
  確認したうえで当てる。ならないなら、作り切る前に聞く。

## 未対応

- **PR #6 の本文とタイトルは古いまま。** 「ドキュメントのみの変更です」という
  実態と食い違う記述が残っている。REST で直せることは 2 で確認済みだが、
  直すかどうかはユーザーの判断待ちのため実行していない
  （検証で投げた PATCH は、現在と同じタイトルを渡す no-op のみ）。
- **`gh` を新しくすれば `pr edit` が直るかは未確認。** バージョンとエラー内容からの推測。
- **`projectCards` エラーが出るサブコマンドを網羅していない。**
  確認したのは `pr create`（成功）、`pr view`（成功）、`pr edit`（失敗）の3つだけ。
- **マージ済み PR の本文を書き換えたときに通知がどう飛ぶかは未確認。**
  直すと判断した場合に確認する。
- **コミットした内容で再デプロイしていない。** throttling の記録から継続の未確認事項。
