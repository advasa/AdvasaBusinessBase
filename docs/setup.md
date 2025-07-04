# AdvasaBusinessBase - セットアップガイド

## 📋 目次

- [前提条件](#前提条件)
- [環境構築](#環境構築)
- [設定ファイル](#設定ファイル)
- [Secrets Manager設定](#secrets-manager設定)
- [VPC設定](#vpc設定)
- [デプロイ前チェック](#デプロイ前チェック)
- [初回デプロイ](#初回デプロイ)
- [Slack統合設定](#slack統合設定)
- [トラブルシューティング](#トラブルシューティング)

## 🔧 前提条件

### 必須ソフトウェア

| ソフトウェア | バージョン | 用途 |
|------------|-----------|------|
| **Node.js** | 22.x以上 | CDK開発環境 |
| **npm** | 11.x以上 | パッケージ管理 |
| **AWS CLI** | 2.x以上 | AWSリソース操作 |
| **AWS CDK CLI** | 2.200.0以上 | インフラデプロイ |
| **Docker** | 20.x以上 | psycopg2レイヤー構築 |
| **Git** | 2.x以上 | ソースコード管理 |

### AWS前提条件

#### 1. AWS アカウント設定
- AWSアカウントアクセス（開発・本番環境）
- 適切なIAM権限を持つユーザー/ロール
- CDK Bootstrap実行権限

#### 2. 既存VPCリソース
```bash
# VPC情報の確認
aws ec2 describe-vpcs --query 'Vpcs[*].[VpcId,CidrBlock,Tags[?Key==`Name`].Value|[0]]' --output table

# サブネット情報の確認
aws ec2 describe-subnets --query 'Subnets[*].[SubnetId,VpcId,CidrBlock,AvailabilityZone,Tags[?Key==`Name`].Value|[0]]' --output table
```

#### 3. データベース環境
- 既存PostgreSQL RDS インスタンス
- データベース接続用セキュリティグループ
- Secrets Managerでの認証情報管理

## 🚀 環境構築

### 1. リポジトリの取得

```bash
# プロジェクトのクローン
git clone https://github.com/advasa/AdvasaBusinessBase.git
cd AdvasaBusinessBase

# ブランチ確認
git branch -a
git checkout main
```

### 2. 依存関係のインストール

```bash
# Node.js依存関係のインストール
npm install

# インストール確認
npm list --depth=0
```

**主要依存関係**:
```json
{
  "aws-cdk-lib": "^2.200.0",
  "constructs": "^10.4.2",
  "typescript": "~5.8.3"
}
```

### 3. TypeScript設定

```bash
# TypeScriptのビルド
npm run build

# ビルド確認
ls -la lib/
```

### 4. AWS CDK初期設定

```bash
# CDK バージョン確認
npx cdk --version

# Bootstrap実行 (初回のみ)
npx cdk bootstrap aws://YOUR_ACCOUNT_ID/ap-northeast-1

# Bootstrap確認
aws cloudformation describe-stacks --stack-name CDKToolkit
```

### 5. psycopg2レイヤーの構築

```bash
# Dockerを使用してpsycopg2レイヤーを構築
cd layers/psycopg2

# build.shスクリプトを実行
chmod +x build.sh
./build.sh

# 構築確認
ls -la python/
cd ../../
```

**build.shの内容**:
```bash
#!/bin/bash
# Amazon Linux 2023環境でpsycopg2-binaryを構築
docker run --rm -v "$PWD":/var/task public.ecr.aws/lambda/python:3.11 \
  pip install psycopg2-binary==2.9.9 -t /var/task/python/
```

## ⚙️ 設定ファイル

### 1. 基本設定ファイル構成

```
config/
├── dev.json     # 開発環境設定
├── stg.json     # ステージング環境設定
└── prod.json    # 本番環境設定
```

### 2. 開発環境設定例 (config/dev.json)

```json
{
  "env": "dev",
  "projectName": "AdvasaBusinessBase",
  "account": "557690584188",
  "region": "ap-northeast-1",
  "profile": "default",
  "tags": {
    "Project": "AdvasaBusinessBase",
    "Environment": "Development",
    "Owner": "AdvasaTeam",
    "CostCenter": "Business"
  },
  "vpc": {
    "vpcId": "vpc-07221a41623db2b5c",
    "privateSubnetIds": [
      "subnet-02a7dc49f85cd9404"
    ],
    "publicSubnetIds": [
      "subnet-096c42d039fd7952c",
      "subnet-01cb0e152d0d89fa9"
    ]
  },
  "database": {
    "secretArn": "arn:aws:secretsmanager:ap-northeast-1:557690584188:secret:advasa-django-db-dev-secret-8DQDEv",
    "host": "dev-devadvasa-database-postgresinstance19cdd68a-igcvkitncf2j.c52s66qg2vl2.ap-northeast-1.rds.amazonaws.com",
    "port": 5432,
    "name": "devadvasa"
  },
  "microservices": {
    "zenginDataUpdater": {
      "enabled": true,
      "lambda": {
        "runtime": "python3.11",
        "timeout": 900,
        "memorySize": 1024,
        "logRetentionDays": 14,
        "environment": {
          "LOG_LEVEL": "DEBUG",
          "ENVIRONMENT": "dev"
        }
      },
      "dynamodb": {
        "diffTableName": "zengin-data-diff-dev",
        "billingMode": "PAY_PER_REQUEST",
        "pointInTimeRecovery": false,
        "removalPolicy": "DESTROY"
      },
      "eventbridge": {
        "dailyScheduleExpression": "cron(0 9 * * ? *)",
        "schedulerGroupName": "zengin-data-updater-dev"
      },
      "slack": {
        "signSecretArn": "arn:aws:secretsmanager:ap-northeast-1:557690584188:secret:slack-signing-secret-dev-s6eKQP",
        "botTokenSecret": "arn:aws:secretsmanager:ap-northeast-1:557690584188:secret:slack-bot-token-dev-B10s9b",
        "channelId": "C093625D0R4"
      }
    }
  },
  "monitoring": {
    "enabled": true,
    "slackNotificationArn": "arn:aws:sns:ap-northeast-1:557690584188:slack-notifications-dev"
  },
  "costOptimization": {
    "autoScaling": {
      "minCapacity": 0,
      "maxCapacity": 2
    },
    "enableSpotInstances": false,
    "cloudWatchMetricsEnabled": true
  }
}
```

### 3. 本番環境設定の違い (config/prod.json)

```json
{
  "env": "prod",
  "projectName": "AdvasaBusinessBase",
  "microservices": {
    "zenginDataUpdater": {
      "lambda": {
        "timeout": 600,
        "memorySize": 2048,
        "logRetentionDays": 30,
        "environment": {
          "LOG_LEVEL": "INFO",
          "ENVIRONMENT": "prod"
        }
      },
      "dynamodb": {
        "diffTableName": "zengin-data-diff-prod",
        "billingMode": "PAY_PER_REQUEST",
        "pointInTimeRecovery": true,
        "removalPolicy": "RETAIN"
      },
      "eventbridge": {
        "dailyScheduleExpression": "cron(0 23 * * ? *)",
        "schedulerGroupName": "zengin-data-updater-prod"
      }
    }
  },
  "monitoring": {
    "enabled": true,
    "alerting": {
      "errorRateThreshold": 3,
      "latencyThreshold": 25000
    }
  },
  "costOptimization": {
    "autoScaling": {
      "minCapacity": 1,
      "maxCapacity": 10
    },
    "enableSpotInstances": false,
    "reservedCapacity": true
  }
}
```

### 4. 設定ファイルの検証

```bash
# 設定ファイル構文チェック
npm run synth:dev

# 設定内容の確認
npx ts-node -e "
import { ConfigLoader } from './lib/common/config';
const config = ConfigLoader.getConfig('dev');
console.log(JSON.stringify(config, null, 2));
"
```

## 🔐 Secrets Manager設定

### 1. データベース認証情報

#### シークレット作成
```bash
# データベースシークレットの作成
aws secretsmanager create-secret \
  --name "advasa-django-db-dev-secret" \
  --description "Database credentials for Advasa Django application (dev)" \
  --secret-string '{
    "username": "advasa_user",
    "password": "your_secure_password",
    "host": "your-db-host.amazonaws.com",
    "port": 5432,
    "database": "advasa_db"
  }' \
  --region ap-northeast-1
```

#### シークレット確認
```bash
# シークレット値の取得
aws secretsmanager get-secret-value \
  --secret-id "advasa-django-db-dev-secret" \
  --query SecretString --output text | jq .
```

### 2. Slack認証情報

#### Bot Token シークレット
```bash
# Slack Bot Tokenの作成
aws secretsmanager create-secret \
  --name "slack-bot-token-dev" \
  --description "Slack Bot Token for development environment" \
  --secret-string '{
    "token": "xoxb-your-bot-token-here"
  }' \
  --region ap-northeast-1
```

#### 署名シークレット
```bash
# Slack署名シークレットの作成
aws secretsmanager create-secret \
  --name "slack-signing-secret-dev" \
  --description "Slack App Signing Secret for development environment" \
  --secret-string '{
    "signingSecret": "your_slack_signing_secret_here"
  }' \
  --region ap-northeast-1
```

### 3. シークレット管理のベストプラクティス

#### 自動ローテーション設定
```bash
# データベースシークレットの自動ローテーション設定 (本番環境)
aws secretsmanager rotate-secret \
  --secret-id "advasa-django-db-prod-secret" \
  --rotation-rules AutomaticallyAfterDays=30
```

#### アクセス権限の制限
```typescript
// IAMポリシー例
const secretsPolicy = new iam.PolicyStatement({
  actions: ['secretsmanager:GetSecretValue'],
  resources: [
    'arn:aws:secretsmanager:ap-northeast-1:557690584188:secret:advasa-django-db-*',
    'arn:aws:secretsmanager:ap-northeast-1:557690584188:secret:slack-*-dev-*'
  ],
  conditions: {
    StringEquals: {
      'secretsmanager:VersionStage': 'AWSCURRENT'
    }
  }
});
```

## 🌐 VPC設定

### 1. VPC情報の取得

```bash
# VPC一覧の取得
aws ec2 describe-vpcs \
  --query 'Vpcs[*].[VpcId,CidrBlock,State,Tags[?Key==`Name`].Value|[0]]' \
  --output table

# サブネット情報の取得
aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=vpc-07221a41623db2b5c" \
  --query 'Subnets[*].[SubnetId,CidrBlock,AvailabilityZone,MapPublicIpOnLaunch,Tags[?Key==`Name`].Value|[0]]' \
  --output table
```

### 2. セキュリティグループの確認

```bash
# セキュリティグループ一覧
aws ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=vpc-07221a41623db2b5c" \
  --query 'SecurityGroups[*].[GroupId,GroupName,Description]' \
  --output table

# データベースアクセス用セキュリティグループの確認
aws ec2 describe-security-groups \
  --group-ids sg-xxxxxxxxx \
  --query 'SecurityGroups[0].IpPermissions[*].[IpProtocol,FromPort,ToPort,IpRanges[0].CidrIp]' \
  --output table
```

### 3. VPCエンドポイントの設定

VPCエンドポイントは`lib/common/networking/vpc-construct.ts`で自動作成されますが、手動で確認可能：

```bash
# VPCエンドポイント一覧
aws ec2 describe-vpc-endpoints \
  --filters "Name=vpc-id,Values=vpc-07221a41623db2b5c" \
  --query 'VpcEndpoints[*].[VpcEndpointId,ServiceName,State]' \
  --output table
```

**必要なVPCエンドポイント**:
- `com.amazonaws.ap-northeast-1.secretsmanager`
- `com.amazonaws.ap-northeast-1.logs`
- `com.amazonaws.ap-northeast-1.events`
- `com.amazonaws.ap-northeast-1.scheduler`
- `com.amazonaws.ap-northeast-1.lambda`

## ✅ デプロイ前チェック

### 1. 設定確認チェックリスト

```bash
# チェック用スクリプト
cat > check-setup.sh << 'EOF'
#!/bin/bash

echo "=== AdvasaBusinessBase セットアップチェック ==="

# AWS CLI設定確認
echo "1. AWS CLI設定確認"
aws sts get-caller-identity
if [ $? -eq 0 ]; then
    echo "✅ AWS CLI設定 OK"
else
    echo "❌ AWS CLI設定エラー"
    exit 1
fi

# CDK Bootstrap確認
echo "2. CDK Bootstrap確認"
aws cloudformation describe-stacks --stack-name CDKToolkit --query 'Stacks[0].StackStatus' --output text
if [ $? -eq 0 ]; then
    echo "✅ CDK Bootstrap OK"
else
    echo "❌ CDK Bootstrap未実行"
    exit 1
fi

# VPC存在確認
echo "3. VPC存在確認"
VPC_ID=$(grep '"vpcId"' config/dev.json | cut -d'"' -f4)
aws ec2 describe-vpcs --vpc-ids $VPC_ID --query 'Vpcs[0].State' --output text
if [ $? -eq 0 ]; then
    echo "✅ VPC設定 OK"
else
    echo "❌ VPC設定エラー"
    exit 1
fi

# Secrets Manager確認
echo "4. Secrets Manager確認"
SECRET_ARN=$(grep '"secretArn"' config/dev.json | head -1 | cut -d'"' -f4)
aws secretsmanager get-secret-value --secret-id $SECRET_ARN --query 'Name' --output text
if [ $? -eq 0 ]; then
    echo "✅ Secrets Manager OK"
else
    echo "❌ Secrets Manager設定エラー"
    exit 1
fi

# psycopg2レイヤー確認
echo "5. psycopg2レイヤー確認"
if [ -d "layers/psycopg2/python" ]; then
    echo "✅ psycopg2レイヤー OK"
else
    echo "❌ psycopg2レイヤー未構築"
    exit 1
fi

echo "=== すべてのチェック完了 ==="
EOF

chmod +x check-setup.sh
./check-setup.sh
```

### 2. TypeScript型チェック

```bash
# 型エラーの確認
npm run build
if [ $? -eq 0 ]; then
    echo "✅ TypeScript型チェック OK"
else
    echo "❌ TypeScript型エラーあり"
    exit 1
fi
```

### 3. CDK 構文チェック

```bash
# CDK構文確認 (dev環境)
npm run synth:dev

# 出力ファイル確認
ls -la cdk.out/
```

## 🚀 初回デプロイ

### 1. 段階的デプロイ手順

#### Step 1: VPC スタックのデプロイ
```bash
# VPCスタックのみデプロイ
npx cdk deploy dev-AdvasaBusinessBase-VPC --context env=dev

# デプロイ確認
aws cloudformation describe-stacks \
  --stack-name dev-AdvasaBusinessBase-VPC \
  --query 'Stacks[0].StackStatus' \
  --output text
```

#### Step 2: Zengin Data Updater スタックのデプロイ
```bash
# Zengin Data Updaterスタックのデプロイ
npx cdk deploy dev-AdvasaBusinessBase-ZenginDataUpdater --context env=dev

# デプロイ確認
aws cloudformation describe-stacks \
  --stack-name dev-AdvasaBusinessBase-ZenginDataUpdater \
  --query 'Stacks[0].StackStatus' \
  --output text
```

#### Step 3: 全スタック一括デプロイ
```bash
# 全スタック一括デプロイ
npm run deploy:dev

# デプロイされたスタック一覧確認
aws cloudformation list-stacks \
  --query 'StackSummaries[?contains(StackName, `AdvasaBusinessBase`)].{Name:StackName,Status:StackStatus}' \
  --output table
```

### 2. デプロイ後の確認

#### Lambda関数の確認
```bash
# Lambda関数一覧
aws lambda list-functions \
  --query 'Functions[?contains(FunctionName, `dev-`)].{Name:FunctionName,Runtime:Runtime,State:State}' \
  --output table

# Lambda関数のテスト
aws lambda invoke \
  --function-name dev-slack-events \
  --payload '{"body": "{\"type\": \"url_verification\", \"challenge\": \"test\"}"}' \
  response.json

cat response.json
```

#### DynamoDB テーブルの確認
```bash
# テーブル一覧
aws dynamodb list-tables \
  --query 'TableNames[?contains(@, `zengin-data-diff`)]' \
  --output table

# テーブル詳細
aws dynamodb describe-table \
  --table-name zengin-data-diff-dev \
  --query 'Table.{Name:TableName,Status:TableStatus,Items:ItemCount}' \
  --output table
```

#### API Gateway の確認
```bash
# API Gateway一覧
aws apigateway get-rest-apis \
  --query 'items[?contains(name, `zengin-slack-api`)].{Name:name,Id:id,CreatedDate:createdDate}' \
  --output table

# エンドポイントURLの取得
API_ID=$(aws apigateway get-rest-apis --query 'items[?contains(name, `dev-zengin-slack-api`)].id' --output text)
echo "API Gateway URL: https://${API_ID}.execute-api.ap-northeast-1.amazonaws.com/v1/"
```

## 💬 Slack統合設定

### 1. Slack アプリの作成

#### アプリ基本設定
1. https://api.slack.com/apps にアクセス
2. "Create New App" → "From scratch"
3. App Name: `AdvasaBusinessBase-dev`
4. Workspace: 対象のSlackワークスペース

#### Bot Token Scopes設定
```
OAuth & Permissions → Scopes → Bot Token Scopes:
- chat:write
- channels:read
- groups:read
- im:read
- mpim:read
```

### 2. Event Subscriptions設定

#### Request URL設定
```
Events Subscriptions → Enable Events: ON
Request URL: https://{API_GATEWAY_ID}.execute-api.ap-northeast-1.amazonaws.com/v1/events
```

#### Subscribe to bot events
```
- message.channels
- message.groups
- message.im
- message.mpim
```

### 3. Interactive Components設定

```
Interactivity & Shortcuts → Interactivity: ON
Request URL: https://{API_GATEWAY_ID}.execute-api.ap-northeast-1.amazonaws.com/v1/interactive
```

### 4. Slack アプリのインストール

```bash
# Bot Tokenの取得
# OAuth & Permissions → Bot User OAuth Token をコピー

# Secrets Managerに設定
aws secretsmanager update-secret \
  --secret-id "slack-bot-token-dev" \
  --secret-string '{
    "token": "xoxb-your-actual-bot-token-here"
  }'

# Signing Secretの取得
# Basic Information → App Credentials → Signing Secret をコピー

# Secrets Managerに設定
aws secretsmanager update-secret \
  --secret-id "slack-signing-secret-dev" \
  --secret-string '{
    "signingSecret": "your_actual_signing_secret_here"
  }'
```

### 5. Slack統合テスト

```bash
# Lambda関数の手動テスト
aws lambda invoke \
  --function-name dev-slack-events \
  --payload '{
    "body": "{\"type\": \"url_verification\", \"challenge\": \"3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P\"}",
    "headers": {
      "X-Slack-Request-Timestamp": "'$(date +%s)'",
      "X-Slack-Signature": "v0=test"
    }
  }' \
  response.json

cat response.json
```

## 🔧 トラブルシューティング

### 1. よくあるエラーと解決方法

#### CDK Bootstrap エラー
```
Error: This stack uses assets, so the toolkit stack must be deployed to the environment
```

**解決方法**:
```bash
npx cdk bootstrap aws://YOUR_ACCOUNT_ID/ap-northeast-1
```

#### psycopg2 インポートエラー
```
Error: No module named 'psycopg2'
```

**解決方法**:
```bash
cd layers/psycopg2
rm -rf python/
./build.sh
cd ../../
npm run deploy:dev
```

#### VPC設定エラー
```
Error: VPC vpc-xxxxx not found
```

**解決方法**:
```bash
# VPC IDの確認
aws ec2 describe-vpcs --query 'Vpcs[*].[VpcId,Tags[?Key==`Name`].Value|[0]]' --output table

# config/dev.jsonのvpcIdを正しい値に更新
```

#### Lambda VPC 接続タイムアウト
```
Error: Task timed out after 30.00 seconds
```

**解決方法**:
```bash
# VPCエンドポイントの確認
aws ec2 describe-vpc-endpoints \
  --filters "Name=vpc-id,Values=vpc-07221a41623db2b5c" \
  --query 'VpcEndpoints[*].[ServiceName,State]' \
  --output table

# Lambda設定のメモリサイズ増加
# config/dev.json → microservices.zenginDataUpdater.lambda.memorySize: 1024 → 2048
```

### 2. ログ確認方法

#### CloudWatch Logs
```bash
# Lambda関数のログ確認
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/dev-" \
  --query 'logGroups[*].logGroupName' \
  --output table

# 最新ログの確認
aws logs tail /aws/lambda/dev-zengin-diff-processor --follow
```

#### X-Ray トレーシング
```bash
# トレースの確認
aws xray get-trace-summaries \
  --time-range-type TimeRangeByStartTime \
  --start-time $(date -d '1 hour ago' +%s) \
  --end-time $(date +%s)
```

### 3. デバッグ用コマンド集

#### 環境確認コマンド
```bash
# 現在の設定確認
npm run synth:dev | head -20

# スタック一覧
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?contains(StackName, `AdvasaBusinessBase`)].StackName' \
  --output text

# リソース一覧
aws cloudformation describe-stack-resources \
  --stack-name dev-AdvasaBusinessBase-ZenginDataUpdater \
  --query 'StackResources[*].[LogicalResourceId,ResourceType,ResourceStatus]' \
  --output table
```

#### 手動テスト用コマンド
```bash
# DynamoDBテーブルの手動テスト
aws dynamodb put-item \
  --table-name zengin-data-diff-dev \
  --item '{
    "id": {"S": "test-diff-001"},
    "timestamp": {"S": "'$(date -Iseconds)'"},
    "status": {"S": "pending"},
    "diffType": {"S": "test"}
  }'

# Lambda関数の手動テスト
aws lambda invoke \
  --function-name dev-zengin-diff-processor \
  --payload '{"trigger": "manual", "test": true}' \
  response.json
```

このセットアップガイドに従うことで、AdvasaBusinessBaseプロジェクトを正常にデプロイし、運用開始できます。