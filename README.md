# AdvasaBusinessBase CDK

AdvasaBusinessBaseは、Advasaのビジネスロジックを担うマイクロサービス群をAWS上でコスト効率良く運用するためのAWS CDKプロジェクトです。

![AWS](https://img.shields.io/badge/AWS-232F3E?style=for-the-badge&logo=amazon-aws&logoColor=white)
![CDK](https://img.shields.io/badge/AWS_CDK-FF9900?style=for-the-badge&logo=amazon-aws&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)

## 📋 目次

- [概要](#概要)
- [アーキテクチャ](#アーキテクチャ)
- [マイクロサービス](#マイクロサービス)
- [セットアップ](#セットアップ)
- [設定](#設定)
- [デプロイ](#デプロイ)
- [使用方法](#使用方法)
- [ドキュメント](#ドキュメント)
- [トラブルシューティング](#トラブルシューティング)

## 🎯 概要

AdvasaBusinessBaseは、既存のAdvasa基盤システムとは独立したCDKリポジトリとして設計されており、以下の特徴を持ちます：

### ✨ 主要特徴

- **🔧 拡張性**: 新しいマイクロサービスを簡単に追加可能
- **🌍 マルチ環境**: dev/stg/prodの環境別デプロイサポート
- **🔒 セキュリティ**: VPCプライベート配置、最小権限IAM、VPCエンドポイント
- **💰 コスト最適化**: 適切なリソース設定とタグ管理
- **📊 監視**: CloudWatch統合とSlack通知、X-Ray分散トレーシング
- **🧪 テスト**: 包括的なユニットテスト
- **🚀 API統合**: API Gateway経由のSlack Events/Interactive API

## 🏗️ アーキテクチャ

### 全体構成
```
┌─────────────────────────────────────────────────────────────┐
│                    AdvasaBusinessBase                        │
├─────────────────────────────────────────────────────────────┤
│  📦 Microservices Layer                                     │
│  ├── 🏦 ZenginDataUpdater (銀行データ同期)                    │
│  │   ├── 🔍 Diff Processor Lambda                          │
│  │   ├── ⚡ Callback Handler Lambda                        │
│  │   ├── 🚀 Diff Executor Lambda                           │
│  │   ├── 📢 Slack Events Lambda                            │
│  │   └── 🔄 Slack Interactive Lambda                       │
│  └── 📈 [Future Services]                                  │
├─────────────────────────────────────────────────────────────┤
│  🔧 Common Infrastructure                                   │
│  ├── 🌐 VPC Integration (既存VPCに接続)                      │
│  ├── 🔗 VPC Endpoints (PrivateLink)                        │
│  ├── 🗄️ DynamoDB Tables                                     │
│  ├── ⏰ EventBridge Schedulers                              │
│  ├── 🔐 Secrets Manager                                     │
│  ├── 🌐 API Gateway                                         │
│  ├── 📊 CloudWatch Monitoring                               │
│  └── 📝 Enhanced Logging                                    │
└─────────────────────────────────────────────────────────────┘
```

### ネットワーク構成
```
┌──────────────────────────────────────────────────────────────┐
│                    既存 Advasa VPC                           │
│  ┌─────────────────────┐  ┌─────────────────────────────────┐  │
│  │   Private Subnet    │  │      Private Subnet             │  │
│  │                     │  │                                 │  │
│  │  ┌──Lambda Functions │  │  ┌──RDS (advasa-django)        │  │
│  │  │  ├─ Diff Processor│  │  │                             │  │
│  │  │  ├─ Callback      │  │  │  ┌──Security Groups        │  │
│  │  │  ├─ Executor      │  │  │  │  └─ Database Access     │  │
│  │  │  ├─ Slack Events  │  │  │                             │  │
│  │  │  └─ Interactive   │  │  │                             │  │
│  │  │                  │  │  │                             │  │
│  │  └──DynamoDB Tables  │  │  └─────────────────────────────│  │
│  └─────────────────────┘  └─────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                 VPC Endpoints                               ││
│  │  ├─ Secrets Manager ├─ CloudWatch Logs ├─ EventBridge     ││
│  │  ├─ CloudWatch      ├─ EventBridge Scheduler ├─ Lambda    ││
│  └─────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

## 🔧 マイクロサービス

### 🏦 Zengin Data Updater

銀行情報の自動更新システム。全銀データとの差分を検出し、Slack承認フローを経て更新を実行します。

#### 📊 システムフロー
```
[毎日 EventBridge] 
        ↓
   🔍 Lambda① (差分取得・比較)
        ↓
 💾 DynamoDB (差分レコード保存) ←┐
        ↓                     │
 🌐 API Gateway ←─── 💬 Slack通知               │
        ↓                     │
[👤 ユーザがSlackで承認／却下＋スケジュール選択] 
        ↓
⚡ Lambda② (コールバック受信・スケジュール登録)  
        ↓
┌───⏰ EventBridge Scheduler (一度きりスケジュール)───┐
│                                                    │
│     [23:00／即時／1h後／3h後／5h後 など]            │
│                                                    ↓
└──────────────→ 🚀 Lambda③ (差分更新実行) ─────────→ 🗄️ RDS (advasa-django DB)
                                                      ↓
                                                📱 Slackへ結果通知
```

#### 🔧 技術スタック

**インフラストラクチャ:**
- **Lambda Functions**: Python 3.11ランタイム (psycopg2レイヤー付き)
- **DynamoDB**: 差分データストレージ（TTL、GSI付き）
- **EventBridge**: スケジューリング（日次 + 動的）
- **Secrets Manager**: 認証情報管理
- **API Gateway**: Slack Webhook エンドポイント
- **S3**: 大容量差分データ保存
- **CloudWatch**: 監視・ログ・アラーム

**主要コンポーネント:**

1. **🔍 Diff Processor Lambda** (`src/lambda/zengin-diff-processor/`)
   - 外部全銀データの取得
   - 既存DBデータとの比較
   - 差分データの保存（DynamoDB + S3）
   - Slack通知の送信

2. **⚡ Callback Handler Lambda** (`src/lambda/zengin-callback-handler/`)
   - Slackインタラクティブ操作の処理
   - ユーザー承認/却下の処理
   - EventBridge Schedulerでのスケジューリング

3. **🚀 Executor Lambda** (`src/lambda/zengin-diff-executor/`)
   - 承認された差分の実行
   - PostgreSQLデータベース更新
   - 完了通知の送信

4. **📢 Slack Events Lambda** (`src/lambda/slack-events/`)
   - Slack Events API エンドポイント
   - チャレンジレスポンス処理

5. **🔄 Slack Interactive Lambda** (`src/lambda/slack-interactive/`)
   - Slack インタラクティブコンポーネント処理
   - ボタン・セレクト等のユーザー操作処理

## 🚀 セットアップ

### 前提条件

- **Node.js 22+** & npm
- **AWS CLI** (適切な認証情報設定済み)
- **AWS CDK CLI v2.200.0+**
- **Docker** (psycopg2レイヤー作成用)

### 1. リポジトリのクローン

```bash
git clone https://github.com/advasa/AdvasaBusinessBase.git
cd AdvasaBusinessBase
```

### 2. 依存関係のインストール

```bash
npm install
```

### 3. AWS CDK の初期設定

```bash
# CDK Bootstrap (初回のみ)
npx cdk bootstrap aws://YOUR_ACCOUNT_ID/ap-northeast-1

# TypeScript のビルド
npm run build
```

### 4. psycopg2レイヤーの作成

```bash
cd layers/psycopg2
./build.sh
```

## ⚙️ 設定

### 環境設定ファイル

各環境の設定を `config/` ディレクトリで管理：

```
config/
├── dev.json     # 開発環境設定
├── stg.json     # ステージング環境設定
└── prod.json    # 本番環境設定
```

### 主要設定項目

**基本設定**:
- AWSアカウントID・リージョン
- プロジェクト名・環境名
- タグ設定

**VPC設定**:
- 既存VPC ID
- プライベート・パブリックサブネットID

**マイクロサービス設定**:
- Lambda設定（メモリ・タイムアウト・環境変数）
- DynamoDB設定（テーブル名・課金モード・TTL）
- EventBridge設定（スケジュール式・グループ名）
- Slack設定（シークレットARN・チャンネルID）

詳細は [docs/setup.md](docs/setup.md) を参照してください。

## 🚀 デプロイ

### クイックデプロイ

```bash
# 開発環境にデプロイ
npm run deploy:dev

# ステージング環境にデプロイ  
npm run deploy:stg

# 本番環境にデプロイ
npm run deploy:prod
```

### 段階的デプロイ

```bash
# 1. 設定確認
npm run synth:dev

# 2. 差分確認
npm run diff:dev

# 3. デプロイ実行
npx cdk deploy --context env=dev "*"
```

**注意**: CLAUDE.mdの指示に従い、デプロイコマンドは自動実行せず、必要なコマンドを提示します。

## 📖 使用方法

### 日常運用

#### 1. ログの確認
```bash
# Lambda関数のログ確認
aws logs tail /aws/lambda/dev-zengin-diff-processor --follow

# エラーログの確認
aws logs filter-log-events \
  --log-group-name /aws/lambda/dev-zengin-diff-processor \
  --filter-pattern "ERROR"
```

#### 2. DynamoDB データの確認
```bash
# 差分テーブルの確認
aws dynamodb scan --table-name zengin-data-diff-dev
```

#### 3. 手動実行
```bash
# 差分処理の手動実行
aws lambda invoke \
  --function-name dev-zengin-diff-processor \
  --payload '{"trigger": "manual"}' \
  response.json
```

### Slack統合

**設定要素**:
- Events API エンドポイント: `{API_GATEWAY_URL}/events`
- Interactive Components エンドポイント: `{API_GATEWAY_URL}/interactive`
- Bot Token Scopes: `chat:write`, `channels:read`
- 署名シークレットの設定

## 🧪 テスト

```bash
# 全テストの実行
npm test

# カバレッジ付きテスト
npm run test:coverage

# 特定のテストファイル
npm test -- config.test.ts
```

## 📚 ドキュメント

詳細なドキュメントは `docs/` ディレクトリにあります：

| ドキュメント | 内容 |
|-------------|------|
| [docs/architecture.md](docs/architecture.md) | システムアーキテクチャ詳細 |
| [docs/setup.md](docs/setup.md) | セットアップとコンフィグレーション |
| [docs/deployment.md](docs/deployment.md) | デプロイメントガイド |
| [docs/api-reference.md](docs/api-reference.md) | API仕様とエンドポイント |
| [docs/database-schema.md](docs/database-schema.md) | データベーススキーマ |

## 🛠️ トラブルシューティング

### よくある問題

#### 1. VPC設定エラー
```
Error: VPC vpc-xxxxx not found
```
**解決方法**: `config/*.json` の `vpcId` が正しいか確認

#### 2. psycopg2 インポートエラー
```
Error: No module named 'psycopg2'
```
**解決方法**: `layers/psycopg2/build.sh` を実行してレイヤーを再作成

#### 3. Slack署名検証エラー
```
Error: Invalid Slack signature
```
**解決方法**: Secrets Managerの署名シークレットが正しく設定されているか確認

#### 4. Lambda VPC接続タイムアウト
```
Error: Task timed out after X seconds
```
**解決方法**: VPCエンドポイントが正しく設定されているか確認、メモリサイズ増加

### デバッグ方法

#### 1. CloudWatch Logs の確認
```bash
# リアルタイムログ監視
aws logs tail /aws/lambda/FUNCTION_NAME --follow

# エラーログの検索
aws logs filter-log-events \
  --log-group-name /aws/lambda/FUNCTION_NAME \
  --filter-pattern "ERROR"
```

#### 2. X-Ray 分散トレーシング
- Lambda関数の詳細な実行トレースを確認
- 外部API呼び出し・データベース接続の性能分析

#### 3. CloudWatch メトリクス
- Lambda実行時間・エラー率
- DynamoDB読み書きスループット
- API Gateway レスポンス時間

## 📁 ディレクトリ構造

```
AdvasaBusinessBase/
├── bin/                              # CDKエントリーポイント
│   └── advasa-business-base.ts
├── lib/                              # CDKコンストラクト
│   ├── common/                       # 共通インフラ
│   │   ├── config.ts                # 設定管理
│   │   ├── infrastructure/          # インフラコンポーネント
│   │   │   ├── dynamodb-construct.ts
│   │   │   ├── eventbridge-construct.ts
│   │   │   ├── secrets-construct.ts
│   │   │   └── api-gateway-construct.ts
│   │   ├── monitoring/              # 監視コンポーネント
│   │   │   ├── cloudwatch-construct.ts
│   │   │   ├── x-ray-construct.ts
│   │   │   └── monitoring-stack.ts
│   │   └── networking/              # ネットワーク設定
│   │       └── vpc-construct.ts
│   └── microservices/              # マイクロサービス
│       └── zengin-data-updater/
│           ├── lambda-construct.ts
│           └── zengin-data-updater-stack.ts
├── src/                             # ソースコード
│   └── lambda/                      # Lambda関数
│       ├── common/                  # 共通ユーティリティ
│       ├── zengin-diff-processor/
│       ├── zengin-callback-handler/
│       ├── zengin-diff-executor/
│       ├── slack-events/
│       └── slack-interactive/
├── config/                          # 環境設定
│   ├── dev.json
│   ├── stg.json
│   └── prod.json
├── layers/                          # Lambda レイヤー
│   └── psycopg2/
├── test/                            # テストファイル
├── docs/                            # ドキュメント
└── scripts/                         # ユーティリティスクリプト
```

## 🔧 新しいマイクロサービスの追加

### 1. 設定ファイルの更新
```json
// config/dev.json に追加
{
  "microservices": {
    "zenginDataUpdater": { ... },
    "newService": {
      "enabled": true,
      "lambda": { ... }
    }
  }
}
```

### 2. CDKスタックの作成
```typescript
// lib/microservices/new-service/new-service-stack.ts
export class NewServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: NewServiceStackProps) {
    super(scope, id, props);
    // スタック実装
  }
}
```

### 3. エントリーポイントの更新
```typescript
// bin/advasa-business-base.ts に追加
if (config.microservices.newService?.enabled) {
  const newServiceStack = new NewServiceStack(app, `${config.env}-NewService`, {
    config,
    vpcConstruct,
    env: deployEnv,
  });
  stacks.push(newServiceStack);
}
```

## 📄 ライセンス

このプロジェクトはMITライセンスの下で公開されています。

## 👥 チーム

- **開発チーム**: advasa-dev@example.com
- **インフラチーム**: advasa-infra@example.com
- **プロジェクトマネージャー**: pm@advasa.com

---

**Powered by AWS CDK & Advasa Engineering Team** 🚀