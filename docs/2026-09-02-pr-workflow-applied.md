# 2026-09-02 前回の学びを次の PR で適用した回と、`gh pr list` で PR が「消えた」件

## 背景

同じ日に [PR 本文がズレた件](2026-09-02-pr-body-drift.md) を記録した直後の作業。
その記録に残した学び（**PR は変更セットが確定してから作る** / **push したらその足で本文を直す**）を、
今度は適用する側に回った回。前提となっていた状態は次のとおり。

- `main` は PR #6 をマージ済み（`4da85df`）
- 手元には**未 push のドキュメントブランチ** `docs/pr-body-drift`（1コミット）
- 同じ作業ツリーに、**ユーザーが作業中の未コミット変更**が同居していた
  （`src/taskHandler.js`（未追跡）、`serverless.yml`、`package.json`、`package-lock.json`）

やることは2つ。

1. Lambda の 500 調査の記録を書いて PR にする
2. ユーザーの `taskPost` 一式を別 PR にする

**ドキュメントと、他人が編集中のコードが、1つの作業ツリーに混ざっている**という状況が今回の肝だった。

## 詰まった点と対処

### 1. 順序を変えた。PR を最後に作り、作成直後に中身を突き合わせた

前回は「PR を作る → あとからコミットを足す」で本文がズレた。今回は逆にした。

ドキュメントを書く → README の参照を張る → コミット → push → **最後に** PR 作成 → 作成直後に照合。

```
$ gh api repos/kazu1998727/aws-lamda-sample/pulls/7 --jq '...'
title: docs: 2026-09-02 の作業記録2件（PR 本文のズレ / Lambda 500 の調査）
state: open  commits: 2  files: 3

$ gh api repos/kazu1998727/aws-lamda-sample/pulls/7/files --jq '.[] | "\(.status)\t\(.filename)"'
modified	README.md
added	docs/2026-09-02-lambda-500-debugging.md
added	docs/2026-09-02-pr-body-drift.md
```

本文に書いた内容と実際のファイルが一致していることを、作成した直後に確認した。
PR #6 のときはこの照合をやっていなかった。**1コマンドで済む。**

### 2. 「マージが速い」が実測2件で裏付けられた

前回の記録に「PR 作成からマージまで1分53秒だった」と書いたが、1件では偶然の可能性があった。
今回も測れたので並べる。

```
$ gh api repos/kazu1998727/aws-lamda-sample/pulls/7 --jq '...'
created: 2026-09-02T05:44:20Z
merged_at: 2026-09-02T05:45:43Z
merged_by: kazu1998727
```

| PR | 作成 | マージ | 差 |
| --- | --- | --- | --- |
| #6 | 03:21:50Z | 03:23:43Z | 1分53秒 |
| #7 | 05:44:20Z | 05:45:43Z | 1分23秒 |

2件とも2分未満。**このリポジトリでは「あとで本文を直す」は間に合わない。**
前回の学びは、この環境では努力目標ではなく必須条件だった。

### 3. ブランチ名が中身と合わなくなったので、push 前に改名した

`docs/pr-body-drift` に、別トピックの記録（Lambda 500 の調査）も載せることになった。
名前が中身を説明しなくなるので改名した。

```
$ git branch -m docs/worklogs-2026-09-02
```

**未 push のローカルブランチなら改名は安全**（リモート追跡ブランチもまだ無い）。
push 後だと別ブランチ扱いになり、古い方が残る。名前の判断は push 前に済ませる。

分ける案（2件目を `main` から別ブランチで切る）も考えたが、**両方の記録が README の同じ箇所を編集する**ため、
分けると必ず衝突する。トピックは別でも1本にまとめた方が安かった。

### 4. 未コミットの変更を、PR を出したばかりのブランチに混ぜかけた

ユーザーの `taskPost` 一式をコミットする段になったとき、作業ツリーは
`docs/worklogs-2026-09-02`（PR #7 を出した直後）の上にあった。

そのままコミットすれば、**#7 の本文が「ドキュメントのみです」と言っているのに実装が混ざる**。
PR #6 とまったく同じ失敗になるところだった。`main` から新しいブランチを切ってから add した。

```
$ git checkout -q -b feat/task-post main
$ git status --short
M  package-lock.json
M  package.json
M  serverless.yml
A  src/taskHandler.js
```

**未コミットの変更はブランチを切り替えても保持される**ので、`stash` は要らなかった。
逆に言うと、変更は勝手に付いてくるので、**どのブランチの上でコミットするかは自分で選ばないといけない**。

### 5. `gh pr list` から PR #7 が消えて、確認せずに「消えた」と報告した

PR #8 を作った直後の確認で、一覧に #8 しか出なかった。

```
$ gh pr list --json number,title,headRefName --jq '.[] | "#\(.number) [\(.headRefName)] \(.title)"'
#8 [feat/task-post] feat: POST /tasks を追加し、DynamoDB にタスクを保存する
```

直前に `state: open` を確認していた #7 が無い。そこで「マージまたはクローズされたようです」と報告した。
断定は避けたものの、**確認できることを確認せずに報告したのが雑だった。**

`gh pr list` は**既定で open の PR しか表示しない**。消えたのではなく仕様どおりで、
`--state all` を付ければ1コマンドで分かる。

```
$ gh pr list --state all --json number,state,title --jq '.[] | "#\(.number) \(.state) \(.title)"'
#8 OPEN   feat: POST /tasks を追加し、DynamoDB にタスクを保存する
#7 MERGED docs: 2026-09-02 の作業記録2件（PR 本文のズレ / Lambda 500 の調査）
#6 MERGED docs: HTTP API に throttling を入れた理由と、その過程で誤認した点を記録
...
```

実際は 05:45:43Z にマージされていた。1コマンド打てば「消えた」という言葉を使わずに済んだ。

### 6. 古い `main` から分岐したブランチが、それでも clean だった

`feat/task-post` は #7 がマージされる**前**の `main` から切ったので、マージ済みの docs コミットを含んでいない。

```
$ git merge-base --is-ancestor 485e77f origin/feat/task-post && echo "含む" || echo "含まない"
含まない（#7 マージ前から分岐）
```

分岐が古いのでコンフリクトを疑ったが、GitHub 上は clean だった。

```
$ gh api repos/kazu1998727/aws-lamda-sample/pulls/8 --jq '...'
state: open  mergeable: true  mergeable_state: clean
```

触っているファイルが重ならない（docs / README と実装ファイル）ため。
**「古いベースから切った」ことと「衝突する」ことは別。** 慌てて rebase する前に状態を見ればよかった。

### 7. この記録を書こうとしたら、ユーザーが同じ作業ツリーで編集中だった

この記録を書くために `main` へ切り替えようとしたら止められた。

```
$ git checkout -q main
error: Your local changes to the following files would be overwritten by checkout:
	serverless.yml
	src/taskHandler.js
Please commit your changes or stash them before you switch branches.
Aborting
```

見にいくと、`GET /tasks`（`taskHandler.list`）の追加と、IAM を関数レベルから
`provider` 側へ移す変更が入っていた。**ユーザーが編集中の、まだ完成していない変更**だった。

ここで `stash` すると相手の作業を勝手に退避することになり、`commit` すればもっと悪い。
`git worktree` で**別ディレクトリに独立した作業ツリー**を作り、そこで記録を書いた。

```
$ git worktree add -q "$WT" -b docs/pr-workflow-applied origin/main
$ git -C "$WT" status --short
(何も無い＝clean)

$ git status --short          # ユーザーの作業ツリー
 M serverless.yml
 M src/taskHandler.js
```

ユーザー側の作業ツリーは無傷のまま、こちらは `origin/main` を基点にした clean な場所で作業できた。
**1つのリポジトリを2人で触るとき、`git worktree` は「相手の作業ツリーに触らない」ための道具になる。**

## 学び

- **PR は最後に作る。作ったら、その場で本文と実際の差分を突き合わせる。**
  `gh api repos/OWNER/REPO/pulls/N/files` で確認できる。書いた内容と実物が合っているかは、
  記憶ではなく出力で確かめる。
- **「あとで直す」が成立するかは、その環境のマージの速さで決まる。**
  実測すれば判断できる。数分でマージされる運用なら、「作ってから直す」前提は捨てる。
- **未コミットの変更はブランチを切り替えても付いてくる。**
  だから「どのブランチの上でコミットするか」は明示的に選ぶ必要がある。
  add する前に `git branch --show-current` を見る。直前に PR を出したブランチの上にいるときはとくに危ない。
- **他人が編集中の作業ツリーでは、`stash` も `commit` も勝手にやらない。**
  自分の作業だけ切り離したいなら `git worktree add` で別の作業ツリーを作る。
  `checkout` が「上書きされます」と止めてくれたら、それは相手の未保存の作業を守っている合図。
- **ブランチ名が中身と合わなくなったら、push 前なら改名でよい。**
  push 後は別ブランチ扱いになるので、名前の判断は push 前に済ませる。
- **同じファイルを触る変更を無理に分けると、衝突を自分で作る。**
  トピックが別でも、README のような共通ファイルを両方が編集するならまとめた方が安い。
- **ツールの既定の絞り込みを、状態の変化と読み違えない。**
  一覧から消えた＝消滅ではない。`gh pr list` は既定で open のみ。
  状態について何か言う前に、状態を問い合わせる（`--state all`、`gh pr view N --json state`）。
- **分岐が古いことと、マージできないことは別。**
  触るファイルが重ならなければ clean。`mergeable_state` を見てから動く。

## 未対応

- **PR #6 の本文とタイトルは古いまま。** 「ドキュメントのみの変更です」という実態と食い違う記述が残っている。
  `gh api -X PATCH` で直せることは確認済みだが、判断待ちで実行していない。
- **PR #8（`feat/task-post`）は未マージ。** レビュー待ち。
- **ユーザーが編集中の `GET /tasks` 追加と IAM の移動には触っていない。**
  作業中の変更のため、コミットも PR も作っていない。
  なお、この変更が入ると PR #8 の本文（`POST /tasks` のみを説明）が実態とズレる。
  同じ失敗の3回目になるので、コミットする前に PR #8 の本文を見直すのが望ましい。
- **`feat/task-post` を最新の `main` に追随させていない。** `mergeable_state: clean` なので不要だが、
  マージ後の `main` で実際に動かす確認はしていない（**未確認**）。
- **動作確認で作ったテスト行（`hello-task`）が `tasks` テーブルに残っている。**
  AWS の認証情報が期限切れのままで、削除も件数の再確認もできていない。
- **README 上部が Serverless の公式テンプレートのままなのは、以前からの持ち越し。** 今回も直していない。
