# Event Scheduler

カンファレンスのセッション管理・スタッフ配置を行うWebアプリケーション。

## 利用方法

### 基本的な流れ

1. **部屋を登録** — 会場の部屋名・収容人数を設定
2. **セッションを登録** — セッショングループ（日程）ごとに、タイトル・時間・部屋を設定。LT・パネルディスカッションは複数登壇者に対応
3. **スタッフを登録** — 名前・スキル・対応可能時間帯・希望セッションを設定
4. **スタッフを配置** — 手動配置、または自動配置アルゴリズムで一括割り当て
5. **確認・エクスポート** — 全体スケジュール・スタッフ別詳細で確認し、Excel出力

### 主な機能

| タブ | 内容 |
|------|------|
| 全体スケジュール | 全セッション・配置表の表示 |
| スタッフ別詳細 | スタッフごとの担当一覧 |
| 会場 | 会場地図の表示 |
| 全体スケジュール管理 | セッションの追加・編集・削除 |
| スタッフ管理 | スタッフの登録・スキル・希望・可用時間の管理 |
| 部屋管理 | 部屋の追加・編集・削除 |
| 会場地図 | フロアマップ画像のアップロード |
| 配置アルゴリズム | スキル・希望・バランスを考慮した自動配置 |
| エクスポート | Excel出力、connpassタイムライン・登壇者テンプレート生成 |
| 公開API | スケジュールJSONの外部配信、Webhook・GitHub Actions連携 |
| バックアップ | 自動バックアップ（間隔/毎日）、手動バックアップ、リストア、履歴管理 |
| 設定 | アプリタイトル、カテゴリ管理、セッショングループ管理、パスワード変更、データ初期化 |

### セッションカテゴリ

デフォルトで以下のカテゴリが用意されています。設定画面から追加・編集・削除が可能です。

- **通常セッション** — 1人の登壇者による発表
- **LT（ライトニングトーク）** — 複数登壇者を登録可能
- **パネルディスカッション** — 複数登壇者を登録可能

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
- GeoIP制限、レート制限、ブルートフォース防止
- セキュリティヘッダー（CSP、X-Frame-Options等）

## サンプルデータ

`sample/sample_data.zip` にサンプルデータを同梱しています。設定画面のリストア機能からインポートすることで、サンプルのセッション・スタッフ・部屋データを確認できます。

## 技術構成

- **Backend**: Python 3.11 + FastAPI + SQLAlchemy + SQLite
- **Frontend**: Vue 3 (CDN) + vanilla JS/CSS
- **Server**: Gunicorn + Uvicorn Worker

## ローカル実行

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

ブラウザで http://localhost:8000 にアクセス。

## 環境変数

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `APP_PASSWORD` | ログインパスワード | `password` |
| `SESSION_SECRET` | Cookie署名キー | (ランダム生成) |
| `RESET_PASSWORD` | 管理者パスワード | `password` |
| `DATA_DIR` | SQLiteファイル保存先 | `./data` |
| `TZ` | タイムゾーン | `Asia/Tokyo` |
| `GEOIP_ENABLED` | GeoIP制限 (`1`で有効) | 無効 |
| `IPINFO_TOKEN` | ipinfo.ioトークン | (なし) |

## デプロイ例

### Azure Web Apps

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

Azureポータルで発行プロファイルをダウンロードし、GitHubリポジトリの Settings > Secrets に `AZURE_WEBAPP_PUBLISH_PROFILE` として登録。

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
zip -r deploy.zip . -x ".git/*" "data/*" "__pycache__/*" "*.pyc"

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
