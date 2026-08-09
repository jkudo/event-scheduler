# Event Scheduler

カンファレンスのセッション管理・スタッフ配置を行うWebアプリケーション。

[![Docker Hub](https://img.shields.io/docker/v/jkudo/event-scheduler?label=Docker%20Hub&sort=semver)](https://hub.docker.com/r/jkudo/event-scheduler)
[![Image size](https://img.shields.io/docker/image-size/jkudo/event-scheduler/latest)](https://hub.docker.com/r/jkudo/event-scheduler)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

すぐ試す場合:

```bash
docker run -d -p 8000:8000 -v event-scheduler-data:/data \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  jkudo/event-scheduler:latest
```

ブラウザで http://localhost:8000 を開くと初期設定画面が出ます。

## 利用方法

### 基本的な流れ

1. **部屋を登録** — 会場の部屋名・収容人数を設定
2. **セッションを登録** — セッショングループ（日程）ごとに、タイトル・時間・部屋を設定。LT・パネルディスカッションは複数登壇者に対応
3. **スタッフを登録** — 名前・担当ロール・英語対応・最大稼働時間・過去参加回数・活動可能時間・希望セッションを設定（Excel/CSVからの一括インポートも可能）
4. **スタッフを配置** — 手動配置、または自動配置アルゴリズムで一括割り当て
5. **確認・エクスポート** — 全体スケジュール・スタッフ別詳細で確認し、Excel出力

### 主な機能

| タブ | 内容 |
|------|------|
| リアルタイム | 現在時刻を基準に進行中・まもなく開始・終了直後の予定を自動更新表示。時刻を指定しての確認、同じ会場の前後の予定と担当者表示 |
| スケジュール | 全セッションの配置表・全日程タイムライン |
| スタッフ別詳細 | スタッフごとの担当一覧。スタッフ名・担当での絞り込み |
| 会場 | 会場地図の表示 |
| 全体スケジュール管理 | 全スタッフ共通の予定（集合・開場・昼休みなど）の追加・編集・削除 |
| {グループ}管理 / {カテゴリ}管理 | セッションの追加・編集・削除（設定で追加したグループ・カテゴリごとにタブが増えます） |
| スタッフ管理 | スタッフの登録（担当ロール・英語対応・稼働上限・活動可能時間・希望セッション）、必要スタッフ数の計算 |
| 部屋管理 | 部屋の追加・編集・削除 |
| 会場地図 | フロアマップ画像のアップロード |
| 全体スケジュール担当 / {グループ}担当 / {カテゴリ}担当 | スタッフの配置（自動配置・選択再配置・未配置・クリア） |
| 配置アルゴリズム | 自動配置の仕組みとスコア表の説明（実行は各「担当」タブから） |
| エクスポート/インポート | Excel出力、スタッフ・セッションのExcel/CSVインポート |
| 公開API | スケジュールJSONの外部配信、Webhook・GitHub Actions連携 |
| バックアップ | 自動バックアップ（間隔/毎日）、手動バックアップ、リストア、履歴管理 |
| 設定 | イベントタイトル・アイコン、タイムゾーン、接続中のデータベース種別の表示、時間重複の許可、別部屋への移動時間、セッション形式管理、担当管理、セッショングループ管理、カテゴリ管理、各パスワードの変更、閲覧用パスワード、データ初期化 |
| マイプロフィール | 閲覧ロールで自分のスタッフ情報を編集 |
| 利用方法 | アプリ内のヘルプ（推奨の進め方、各タブの説明） |

閲覧用パスワードでログインした場合は、参照のみのタブ（リアルタイム・スケジュール・スタッフ別詳細・会場・マイプロフィール・利用方法）が表示されます。

### セッション形式

以下の形式が最初から用意されています（削除・改名はできません）。設定画面から独自の形式を追加でき、追加時に「複数登壇者」の有無を選べます。

| 形式 | 登壇者 |
|------|--------|
| 一般 | 1人 |
| ワークショップ | 1人 |
| 基調講演 | 1人 |
| 基調講演（複数人） | 複数登録可能 |
| パネルディスカッション | 複数登録可能 |
| LT（ライトニングトーク） | 複数登録可能 |

「全体」は全体スケジュール専用の形式です。全スタッフが対象となり、個別のスタッフ登録は不要です。

### インポート・エクスポート

- **Excelエクスポート** — 部屋・セッション・スタッフ・配置・全体スケジュールマトリクス・カテゴリ別の各シートを出力。登壇者写真も埋め込まれます
- **インポート** — スタッフとセッションを Excel(xlsx) または CSV(UTF-8) から一括登録します。列構成はエクスポートと同じで、**エクスポートしたファイルをそのままインポートに使えます**
  - 同名のスタッフ、同タイトル・同開始時刻のセッションはスキップされるため、同じファイルを再投入しても重複しません
  - 未登録の部屋・グループは自動作成されます
  - カテゴリと担当は登録済みの名前のみ指定できます
  - 写真、希望セッション、複数登壇者の内訳は取り込まれません
  - 記入用のテンプレート（xlsx / csv）をダウンロードできます

### 公開API

イベント公式サイト等の外部サイトからスケジュールデータをJSON形式で取得できるAPIを提供します。

- **スナップショット方式** — 「パブリッシュ」で確定したデータのみ公開。編集中のデータは外部に漏れません
- **APIキー認証** — クエリパラメータまたはヘッダーで認証
- **Webhook** — パブリッシュ時に任意のURLへPOST通知
- **GitHub Actions連携** — パブリッシュ時にworkflow_dispatchを自動実行し、GitHub Pages等のキャッシュを更新
- **パブリッシュ履歴** — 過去のスナップショットに切り替え可能

### 自動配置アルゴリズム

スタッフの希望・スキル・対応可能時間・負荷バランスをスコアリングして最適な配置を算出します。配置後に手動で調整も可能です。

### セキュリティ

- パスワードはPBKDF2-SHA256でハッシュ化して保存
- GeoIP制限、API のレート制限
- セキュリティヘッダー（CSP、X-Frame-Options等）
- アップロードは画像形式のみ受け付け、1ファイル10MBまで。保存時に最大512pxへ縮小し、EXIF（位置情報など）は残しません

ログイン試行の回数制限は設けていません。会場のWiFiでは全員が同じグローバルIPになり、他人の入力ミスで締め出されるためです。総当たりに対してはハッシュ計算のコスト（PBKDF2 60万回）で対処しています。

## サンプルデータ

`sample/sample_data.zip` にサンプルデータを同梱しています。設定画面のリストア機能からインポートすることで、サンプルのセッション・スタッフ・部屋データを確認できます。

## 技術構成

- **Backend**: Python 3.10以上（Dockerイメージは 3.12）+ FastAPI + SQLAlchemy + SQLite（WALモード）／PostgreSQL
- **Frontend**: Vue 3 (CDN) + vanilla JS/CSS
- **Server**: Gunicorn + Uvicorn Worker（ワーカー数は `WEB_CONCURRENCY`・既定1）
- **Excel入出力**: openpyxl + Pillow

読み取りAPIの応答はサーバー側で保持され、`ETag` による再検証に対応しています。書き込みがあると保持内容を破棄するため、編集は次の取得から反映されます。`Cache-Control: private, no-cache` を返すので、ブラウザは毎回問い合わせ、変更がなければ `304` で本文が流れません。

## ローカル実行

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

ブラウザで http://localhost:8000 にアクセス。

## 環境変数

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `DATA_DIR` | データ保存先。配下に `scheduler.db`・`uploads/`・`backups/`・`public_snapshots/` が作られる | `.`（Dockerイメージでは `/data`） |
| `DATABASE_URL` | 接続先。指定するとPostgreSQL等に切り替わる | (未設定。`DATA_DIR` 配下のSQLite) |
| `SESSION_SECRET` | セッションCookieの署名キー | (起動ごとにランダム生成) |
| `WEB_CONCURRENCY` | ワーカー（プロセス）数 | `1` |
| `APP_PASSWORD` | ログインパスワード | (未設定。DBの値を使用) |
| `RESET_PASSWORD` | データ初期化・復元用のパスワード | (未設定。DBの値を使用) |
| `GEOIP_ENABLED` | GeoIP制限 (`1`で有効) | 無効 |
| `IPINFO_TOKEN` | ipinfo.ioトークン | (なし) |
| `COOKIE_SECURE` | セッションCookieのSecure属性を強制 (`1`/`0`) | 自動（HTTPSなら付与、HTTPなら付与しない） |

- **`DATA_DIR`**: 永続化したい場所を指定します。Dockerではボリュームを、Azureでは `/home/data` を指定してください
- **`DATABASE_URL`**: 未設定ならSQLiteです。PostgreSQLを使う場合は `postgresql+psycopg://ユーザー:パスワード@ホスト:5432/データベース名` の形式で指定します。画像・バックアップは引き続き `DATA_DIR` に保存されます
- **`WEB_CONCURRENCY`**: CPUコア数の2倍程度が目安です。2vCPU・200セッション/100スタッフの実測では、1→4 で処理能力が約1.6倍になり、4→8 では下がりました。増やすとメモリもプロセス数に比例して増えます
- **`SESSION_SECRET`**: 未設定だと起動のたびに変わるため、再起動やコンテナ入れ替えのたびに全員ログアウトされます。`openssl rand -hex 32` などで生成した値を設定してください。セッションはCookieに署名して持たせる方式（有効期限7日）で、サーバー側には保存されません
- **`APP_PASSWORD` / `RESET_PASSWORD`**: 設定するとその値だけで照合され、画面から変更しても反映されなくなります。通常は未設定にして、初回アクセス時の初期設定画面で設定してください（どちらも初期設定前のフォールバックは `password`）
- **`COOKIE_SECURE`**: Secure属性が付いたCookieはHTTPでは保存されないため、社内LANなどHTTPで運用する場合は自動判定のまま（未設定）にしてください。HTTPS配信時は自動でSecureが付きます

タイムゾーンは環境変数ではなく、**設定画面**（DBに保存）で変更します。既定は `Asia/Tokyo` です。

Azure Web App for Containers では、上記に加えて `WEBSITES_PORT` と `WEBSITES_ENABLE_APP_SERVICE_STORAGE` の設定が必要です（[デプロイ例](#azure-web-app-for-containers)を参照）。

## デプロイ例

### Docker

ビルド済みのイメージを2つのレジストリで公開しています。中身は同じもので、`linux/amd64` と `linux/arm64` に対応しています。

| レジストリ | イメージ | ページ |
|---|---|---|
| Docker Hub | `jkudo/event-scheduler` | https://hub.docker.com/r/jkudo/event-scheduler |
| GitHub Container Registry | `ghcr.io/jkudo/event-scheduler` | https://github.com/jkudo/event-scheduler/pkgs/container/event-scheduler |

タグは `latest`（最新の安定版）とバージョン固定（`0.4.0` など）です。運用環境ではバージョンを固定してください。

Docker Hub のイメージを使う場合:

```bash
docker run -d --name event-scheduler -p 8000:8000 \
  -v event-scheduler-data:/data \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  jkudo/event-scheduler:latest
```

GitHub Container Registry からも同じイメージを取得できます:

```bash
docker run -d --name event-scheduler -p 8000:8000 \
  -v event-scheduler-data:/data \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  ghcr.io/jkudo/event-scheduler:latest
```

ソースからビルドする場合:

```bash
docker compose up -d --build
```

ブラウザで http://localhost:8000 にアクセス。

PostgreSQLを使う場合:

```bash
POSTGRES_PASSWORD=<パスワード> \
  docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

Docker Hub のイメージだけで PostgreSQL 構成にする場合（ソース不要）は、`docker-compose.hub.yml` を1つ置いて実行します:

```bash
POSTGRES_PASSWORD=<パスワード> SESSION_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker-compose.hub.yml up -d
```

- イメージは linux/amd64 と linux/arm64 に対応しています
- データ（SQLite・アップロード画像・バックアップ・公開スナップショット）はボリューム（コンテナ内 `/data`）に保存されます。コンテナを作り直しても保持されます
- 環境変数は `.env` またはシェルから設定します

  ```bash
  SESSION_SECRET=$(openssl rand -hex 32) docker compose up -d
  ```

  `SESSION_SECRET` が未設定の場合、再起動のたびにログインセッションが失効します。
  `APP_PASSWORD` などその他の変数を使う場合は、`docker-compose.yml` の `environment:` にあるコメント行を有効にしてください
- ワーカー数は既定1です。増やす場合は `WEB_CONCURRENCY` を指定します
- SQLiteは接続時に `journal_mode=WAL`・`busy_timeout=30000` を設定します
- **データベースの移行**: 旧環境でバックアップZIPをダウンロードし、新環境のリストア機能から取り込むだけでSQLite⇔PostgreSQLを移行できます（バックアップはDBに依存しないJSON形式のため）。ログインパスワードと管理者パスワードは移行先の環境で設定したものが維持されます
- フロントエンドはVue 3をCDN（unpkg.com）から取得します

#### イメージを公開する

手元からビルドして Docker Hub へ公開する場合:

```bash
docker buildx create --use --name confsched 2>/dev/null || docker buildx use confsched
docker buildx build --platform linux/amd64,linux/arm64 \
  -t <ユーザー名>/event-scheduler:0.4.0 \
  -t <ユーザー名>/event-scheduler:latest --push .
```

GitHub Actions で公開する場合は `.github/workflows/container.yml` を使います。`v0.4.0` のようなタグを push すると、Docker Hub と GitHub Container Registry の両方に、そのタグと `latest` で公開されます。リポジトリのシークレットに `DOCKERHUB_USERNAME` と `DOCKERHUB_TOKEN` を登録してください（GHCR は `GITHUB_TOKEN` を使うため設定は不要です）。

```bash
git tag v0.4.0 && git push origin v0.4.0
```

### Azure Web App for Containers

Docker Hub のイメージを Azure で動かす手順です。

#### Azure CLI で新規作成

```bash
RG=event-scheduler-rg
PLAN=event-scheduler-plan
APP=event-scheduler-$RANDOM          # 世界で一意な名前にする
LOCATION=japaneast

az group create -n $RG -l $LOCATION
az appservice plan create -n $PLAN -g $RG --is-linux --sku B1
az webapp create -n $APP -g $RG -p $PLAN --container-image-name jkudo/event-scheduler:latest

az webapp config appsettings set -n $APP -g $RG --settings \
  WEBSITES_PORT=8000 \
  WEBSITES_ENABLE_APP_SERVICE_STORAGE=true \
  DATA_DIR=/home/data \
  SESSION_SECRET=$(openssl rand -hex 32)

az webapp restart -n $APP -g $RG
echo "https://$(az webapp show -n $APP -g $RG --query defaultHostName -o tsv)"
```

#### ポータルで新規作成

1. **App Service の作成** → 公開: **コンテナー**、オペレーティングシステム: **Linux**
2. **コンテナー** タブ → イメージソース: **Docker Hub**、アクセスの種類: **パブリック**、イメージとタグ: `jkudo/event-scheduler:latest`
3. 作成後、**設定 → 環境変数** で次の4つを追加

   | 名前 | 値 | 用途 |
   |------|----|------|
   | `WEBSITES_PORT` | `8000` | コンテナの待ち受けポート。未設定だと起動確認に失敗する |
   | `WEBSITES_ENABLE_APP_SERVICE_STORAGE` | `true` | `/home` を永続化する。未設定だと再起動でデータが消える |
   | `DATA_DIR` | `/home/data` | データの保存先を永続領域にする |
   | `SESSION_SECRET` | 任意の長いランダム文字列 | 未設定だと再起動のたびにログアウトされる |

4. **概要 → 再起動**
5. ブラウザでアクセスし、初期設定画面でパスワードを設定

イメージを更新したら**デプロイ センター → 設定**で継続的デプロイを **オン** にし、表示される Webhook URL を Docker Hub のリポジトリ設定に登録すると、`docker push` だけで反映されます。

#### 注意

- データ（SQLite・アップロード画像・バックアップ・公開スナップショット）は `/home/data` に保存されます。`WEBSITES_ENABLE_APP_SERVICE_STORAGE` を `false` に戻すと消えます
- Free (F1) プランはカスタムコンテナーに対応していません。B1 以上を選んでください
- SQLiteはWALモードで動作します。WALが使えないストレージでは自動的に既定のジャーナルモードにフォールバックします
- スケールアウト（複数インスタンス）には対応していません。インスタンス数は1のままにしてください。1インスタンス内でのワーカー増設は `WEB_CONCURRENCY` で行えます
- PostgreSQL をサイドカーとして同居させる構成は、`/home` が SMB マウントで所有者が root に固定されるため動きません。PostgreSQL を使う場合はマネージドのDBを `DATABASE_URL` で指定してください

### Azure Web Apps（コンテナを使わない場合）

#### 方法1: GitHub Actions

mainブランチへのpush時に自動デプロイされます。

##### 初回セットアップ

1. **リソース作成**

```bash
az group create --name <リソースグループ名> --location japaneast

az appservice plan create \
  --name <プラン名> \
  --resource-group <リソースグループ名> \
  --sku F1 --is-linux

az webapp create \
  --name <アプリ名> \
  --resource-group <リソースグループ名> \
  --plan <プラン名> \
  --runtime "PYTHON|3.11"
```

2. **スタートアップコマンド設定**

```bash
az webapp config set \
  --name <アプリ名> \
  --resource-group <リソースグループ名> \
  --startup-file "gunicorn -w 1 -k uvicorn.workers.UvicornWorker app.main:app --bind 0.0.0.0:8000"
```

3. **環境変数設定**

```bash
az webapp config appsettings set \
  --name <アプリ名> \
  --resource-group <リソースグループ名> \
  --settings \
    APP_PASSWORD="<ログインパスワード>" \
    SESSION_SECRET="<ランダム文字列>" \
    RESET_PASSWORD="<管理者パスワード>" \
    DATA_DIR="/home/data" \
    SCM_DO_BUILD_DURING_DEPLOYMENT="true"
```

`DATA_DIR` を `/home/data` に設定すると、デプロイ時にデータが消えません（`/home` は永続ストレージ）。

4. **GitHub Actions設定**

Azureポータルで発行プロファイルをダウンロードし、GitHubリポジトリの Settings > Secrets に `AZURE_WEBAPP_PUBLISH_PROFILE` として登録。あわせて `.github/workflows/deploy.yml` の `app-name` を自分のアプリ名に書き換えます。

`.github/workflows/deploy.yml`:

```yaml
name: Deploy to Azure App Service

on:
  push:
    branches:
      - main

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to Azure Web App
        uses: azure/webapps-deploy@v3
        with:
          app-name: <アプリ名>
          publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
```

#### 方法2: Azure CLI で直接デプロイ

```bash
# プロジェクトディレクトリで実行
az webapp up \
  --name <アプリ名> \
  --resource-group <リソースグループ名> \
  --runtime "PYTHON|3.11" \
  --sku F1
```

または ZIP デプロイ:

```bash
# プロジェクトをZIPに圧縮
zip -r deploy.zip . -x ".git/*" ".venv/*" "__pycache__/*" "*.pyc" "*.db*" "uploads/*" "backups/*" "public_snapshots/*"

# デプロイ
az webapp deploy \
  --name <アプリ名> \
  --resource-group <リソースグループ名> \
  --src-path deploy.zip \
  --type zip
```

スタートアップコマンドと環境変数の設定は方法1と同じです。

#### 方法3: ローカルGitデプロイ

```bash
# デプロイソースをローカルGitに設定
az webapp deployment source config-local-git \
  --name <アプリ名> \
  --resource-group <リソースグループ名>

# 出力されたURLをリモートに追加
git remote add azure https://<アプリ名>.scm.azurewebsites.net/<アプリ名>.git

# デプロイ
git push azure main
```

初回pushでAzureのデプロイ資格情報を求められます。資格情報は以下で設定:

```bash
az webapp deployment user set --user-name <ユーザー名> --password <パスワード>
```

## ライセンス

[MIT License](LICENSE)
