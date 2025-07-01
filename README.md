# AdvasaBusinessBase CDK

AWS CDK プロジェクトで、Advasaのビジネスロジックを担うマイクロサービス群をAWS上でコスト効率良く運用するためのインフラストラクチャです。

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
- [ディレクトリ構造](#ディレクトリ構造)
- [トラブルシューティング](#トラブルシューティング)

## 🎯 概要

AdvasaBusinessBaseは、既存のAdvasa基盤システムとは独立したCDKリポジトリとして設計されており、以下の特徴を持ちます：

### ✨ 主要特徴

- **🔧 拡張性**: 新しいマイクロサービスを簡単に追加可能
- **🌍 マルチ環境**: dev/stg/prodの環境別デプロイサポート
- **🔒 セキュリティ**: VPCプライベート配置、最小権限IAM
- **💰 コスト最適化**: 適切なリソース設定とタグ管理
- **📊 監視**: CloudWatch統合とSlack通知
- **🧪 テスト**: 包括的なユニットテスト

## 🏗️ アーキテクチャ

### 全体構成
```
┌─────────────────────────────────────────────────────────────┐
│                    AdvasaBusinessBase                        │
├─────────────────────────────────────────────────────────────┤
│  📦 Microservices                                           │
│  ├── 🏦 ZenginDataUpdater (銀行データ同期)                    │
│  ├── 🔄 [Future Service 1]                                 │
│  └── 📈 [Future Service 2]                                 │
├─────────────────────────────────────────────────────────────┤
│  🔧 Common Infrastructure                                   │
│  ├── 🌐 VPC Integration (既存VPCに接続)                      │
│  ├── 🗄️ DynamoDB Tables                                     │
│  ├── ⏰ EventBridge Schedulers                              │
│  ├── 🔐 Secrets Manager                                     │
│  └── 📝 CloudWatch Logs                                     │
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
│  │  │  └─ Executor      │  │  │  │  └─ Database Access     │  │
│  │  │                  │  │  │                             │  │
│  │  └──DynamoDB Tables  │  │  └─────────────────────────────│  │
│  └─────────────────────┘  └─────────────────────────────────┘  │
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
     💬 Slack通知               │
        ↓                     │ Slackインタラクティブ操作
[👤 ユーザが承認／却下＋スケジュール選択] 
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
- **Lambda Functions**: Python 3.11ランタイム
- **DynamoDB**: 差分データストレージ（Pay-per-request）
- **EventBridge**: スケジューリング（日次 + 動的）
- **Secrets Manager**: 認証情報管理
- **CloudWatch**: ログ・監視

**主要コンポーネント:**

1. **🔍 Diff Processor Lambda**
   - 外部全銀データの取得
   - 既存DBデータとの比較
   - 差分データの保存
   - Slack通知の送信

2. **⚡ Callback Handler Lambda**
   - Slackインタラクティブ操作の処理
   - ユーザー承認/却下の処理
   - スケジューリングの設定

3. **🚀 Executor Lambda**
   - 承認された差分の実行
   - データベース更新
   - 完了通知の送信

## 🚀 セットアップ

### 前提条件

- **Node.js 18+** & npm
- **AWS CLI** (適切な認証情報設定済み)
- **AWS CDK CLI v2.200.1+**
- **GitHub CLI** (オプション - デプロイ自動化用)

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

## ⚙️ 設定

### 環境設定ファイル

各環境の設定を `config/` ディレクトリで管理：

```
config/
├── dev.json     # 開発環境設定
├── stg.json     # ステージング環境設定
└── prod.json    # 本番環境設定
```

### 必須設定項目

#### 1. 基本設定
```json
{
  "account": "123456789012",           // AWSアカウントID
  "region": "ap-northeast-1",          // デプロイリージョン
  "profile": "your-aws-profile"        // AWS CLIプロファイル
}
```

#### 2. VPC設定
```json
{
  "vpc": {
    "vpcId": "vpc-xxxxxxxxx",                    // 既存VPC ID
    "privateSubnetIds": [                        // プライベートサブネット
      "subnet-xxxxxxxxx",
      "subnet-yyyyyyyyy"
    ],
    "publicSubnetIds": [                         // パブリックサブネット
      "subnet-aaaaaaaa",
      "subnet-bbbbbbbb"
    ]
  }
}
```

#### 3. データベース設定
```json
{
  "database": {
    "secretArn": "arn:aws:secretsmanager:...",   // DB認証情報
    "host": "your-db-host.amazonaws.com",
    "port": 5432,
    "name": "advasa_database"
  }
}
```

#### 4. マイクロサービス設定
```json
{
  "microservices": {
    "zenginDataUpdater": {
      "enabled": true,                           // サービス有効/無効
      "lambda": {
        "runtime": "python3.11",
        "timeout": 300,
        "memorySize": 512
      },
      "slack": {
        "webhookSecretArn": "arn:aws:secretsmanager:...",
        "signSecretArn": "arn:aws:secretsmanager:..."
      }
    }
  }
}
```

### Secrets Manager の設定

以下のシークレットをAWS Secrets Managerに作成してください：

#### 1. データベース認証情報
```json
{
  "username": "db_user",
  "password": "db_password",
  "host": "db-host.amazonaws.com",
  "port": 5432,
  "database": "advasa_db"
}
```

#### 2. Slack Webhook
```json
{
  "webhookUrl": "https://hooks.slack.com/services/...",
  "channel": "#alerts"
}
```

#### 3. Slack署名シークレット
```json
{
  "signingSecret": "your_slack_signing_secret"
}
```

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

#### 1. 設定確認
```bash
# 設定の検証
npm run synth:dev
```

#### 2. 差分確認
```bash
# デプロイ前の変更確認
npm run diff:dev
```

#### 3. デプロイ実行
```bash
# 特定のスタックのみデプロイ
npx cdk deploy dev-AdvasaBusinessBase-ZenginDataUpdater --context env=dev

# 全スタックのデプロイ
npx cdk deploy --context env=dev "*"
```

#### 4. デプロイ後の確認
```bash
# スタック状況の確認
aws cloudformation describe-stacks \
  --stack-name dev-AdvasaBusinessBase-ZenginDataUpdater
```

### Lambda関数のコード配置

デプロイ前に、Lambda関数のソースコードを配置してください：

```bash
# 各Lambda関数のディレクトリに移動してコードを配置
src/lambda/
├── zengin-diff-processor/
│   ├── main.py              # メインハンドラー
│   ├── requirements.txt     # 依存関係
│   └── modules/            # 追加モジュール
├── zengin-callback-handler/
│   └── main.py
└── zengin-diff-executor/
    └── main.py
```

## 📖 使用方法

### 日常運用

#### 1. ログの確認
```bash
# Lambda関数のログ確認
aws logs tail /aws/lambda/dev-zengin-diff-processor --follow

# 最近のエラーログの確認
aws logs filter-log-events \
  --log-group-name /aws/lambda/dev-zengin-diff-processor \
  --filter-pattern "ERROR"
```

#### 2. DynamoDB データの確認
```bash
# 差分テーブルの確認
aws dynamodb scan --table-name zengin-data-diff-dev
```

#### 3. スケジューラーの確認
```bash
# EventBridge スケジュールの確認
aws scheduler list-schedules \
  --group-name zengin-data-updater-dev
```

#### 4. 手動実行
```bash
# 差分処理の手動実行
aws lambda invoke \
  --function-name dev-zengin-diff-processor \
  --payload '{"trigger": "manual"}' \
  response.json
```

### モニタリング

#### CloudWatch メトリクス
- Lambda 実行時間・エラー率
- DynamoDB 読み書きキャパシティ使用率
- EventBridge ルール実行状況

#### アラート設定
- Lambda エラー率 > 5%
- DynamoDB スロットリング発生
- スケジュールタスク実行失敗

## 🧪 テスト

### ユニットテスト
```bash
# 全テストの実行
npm test

# カバレッジ付きテスト
npm run test:coverage

# 特定のテストファイルのみ
npm test -- config.test.ts
```

### 統合テスト
```bash
# CDKスタックのテスト
npm test -- zengin-data-updater-stack.test.ts
```

### Lambda関数のローカルテスト
```bash
# SAM CLI を使用したローカルテスト
sam local invoke ZenginDiffProcessor \
  --event events/test-event.json
```

## 📁 ディレクトリ構造

```
AdvasaBusinessBase/
├── 📄 README.md                      # このファイル
├── 📄 CLAUDECODE.md                  # Claude設定
├── ⚙️ cdk.json                       # CDK設定
├── 📦 package.json                   # npm設定
├── 🔧 tsconfig.json                  # TypeScript設定
├── 🧪 jest.config.js                 # テスト設定
├── 🚫 .gitignore                     # Git除外設定
│
├── 📁 bin/                           # CDKエントリーポイント
│   └── advasa-business-base.ts
│
├── 📁 lib/                           # CDKコンストラクト
│   ├── 📁 common/                    # 共通インフラ
│   │   ├── config.ts                # 設定管理
│   │   ├── 📁 infrastructure/       # インフラコンポーネント
│   │   │   ├── dynamodb-construct.ts
│   │   │   ├── eventbridge-construct.ts
│   │   │   └── secrets-construct.ts
│   │   └── 📁 networking/           # ネットワーク設定
│   │       └── vpc-construct.ts
│   └── 📁 microservices/           # マイクロサービス
│       └── 📁 zengin-data-updater/
│           ├── lambda-construct.ts
│           └── zengin-data-updater-stack.ts
│
├── 📁 config/                       # 環境設定
│   ├── dev.json
│   ├── stg.json
│   └── prod.json
│
├── 📁 src/                          # ソースコード
│   └── 📁 lambda/                   # Lambda関数
│       ├── 📁 zengin-diff-processor/
│       ├── 📁 zengin-callback-handler/
│       └── 📁 zengin-diff-executor/
│
└── 📁 test/                         # テストファイル
    ├── setup.ts
    ├── config.test.ts
    └── zengin-data-updater-stack.test.ts
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

## 🛠️ トラブルシューティング

### よくある問題

#### 1. VPC設定エラー
```
Error: VPC vpc-xxxxx not found
```
**解決方法**: `config/*.json` の `vpcId` が正しいか確認

#### 2. IAM権限エラー
```
User: xxx is not authorized to perform: xxx
```
**解決方法**: AWS CLIプロファイルの権限を確認

#### 3. Lambda パッケージエラー
```
Error: Cannot find module 'xxx'
```
**解決方法**: `src/lambda/*/` 配下に必要なファイルが配置されているか確認

#### 4. Secrets Manager アクセスエラー
```
Error: Secrets Manager secret not found
```
**解決方法**: 設定ファイルのSecrets Manager ARNが正しいか確認

### デバッグ方法

#### 1. 詳細ログの有効化
```bash
export CDK_DEBUG=true
npx cdk deploy --context env=dev
```

#### 2. CloudFormation イベントの確認
```bash
aws cloudformation describe-stack-events \
  --stack-name dev-AdvasaBusinessBase-ZenginDataUpdater
```

#### 3. Lambda関数のローカルデバッグ
```bash
# 環境変数を設定してローカル実行
export DIFF_TABLE_NAME=zengin-data-diff-dev
python src/lambda/zengin-diff-processor/main.py
```

### 復旧手順

#### 1. スタックが失敗した場合
```bash
# スタックの削除
npx cdk destroy dev-AdvasaBusinessBase-ZenginDataUpdater --context env=dev

# 再デプロイ
npx cdk deploy dev-AdvasaBusinessBase-ZenginDataUpdater --context env=dev
```

#### 2. Lambda関数のロールバック
```bash
# 以前のバージョンの確認
aws lambda list-versions-by-function \
  --function-name dev-zengin-diff-processor

# 特定バージョンへのロールバック
aws lambda update-alias \
  --function-name dev-zengin-diff-processor \
  --name LIVE \
  --function-version 1
```

## 📚 参考資料

### AWS サービス
- [AWS CDK Developer Guide](https://docs.aws.amazon.com/cdk/)
- [AWS Lambda Developer Guide](https://docs.aws.amazon.com/lambda/)
- [Amazon DynamoDB Developer Guide](https://docs.aws.amazon.com/amazondynamodb/)
- [Amazon EventBridge User Guide](https://docs.aws.amazon.com/eventbridge/)

### 開発ツール
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Jest Testing Framework](https://jestjs.io/docs/getting-started)
- [AWS CLI User Guide](https://docs.aws.amazon.com/cli/)

## 🤝 コントリビューション

1. このリポジトリをフォーク
2. フィーチャーブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを作成

## 📄 ライセンス

このプロジェクトはMITライセンスの下で公開されています。詳細は [LICENSE](LICENSE) ファイルを参照してください。

## 👥 チーム

- **開発チーム**: advasa-dev@example.com
- **インフラチーム**: advasa-infra@example.com
- **プロジェクトマネージャー**: pm@advasa.com

---

**Powered by AWS CDK & Advasa Engineering Team** 🚀