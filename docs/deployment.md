# AdvasaBusinessBase - デプロイメントガイド

## 📋 目次

- [デプロイメント概要](#デプロイメント概要)
- [デプロイメント戦略](#デプロイメント戦略)
- [環境別デプロイ](#環境別デプロイ)
- [ロールバック手順](#ロールバック手順)
- [監視とアラート](#監視とアラート)
- [運用手順](#運用手順)
- [トラブルシューティング](#トラブルシューティング)

## 🚀 デプロイメント概要

AdvasaBusinessBaseは、AWS CDKを使用したIaC（Infrastructure as Code）により、一貫性のあるデプロイメントを実現しています。

### 主要特徴

- **宣言的インフラ**: CDKによるTypeScript記述
- **環境分離**: dev/stg/prod環境の完全分離
- **段階的デプロイ**: スタック単位での段階的展開
- **ロールバック対応**: CloudFormationによる安全な復旧
- **ゼロダウンタイム**: サーバーレスアーキテクチャ

### デプロイメント手順

**注意**: CLAUDE.mdの指示に従い、実際のデプロイコマンドは自動実行せず、以下のコマンドを提示します。

```bash
# 開発環境へのデプロイ
npm run deploy:dev

# ステージング環境へのデプロイ
npm run deploy:stg  

# 本番環境へのデプロイ
npm run deploy:prod
```

## 📐 デプロイメント戦略

### スタック依存関係

1. **VPCスタック**: ネットワーク基盤の構築
2. **ZenginDataUpdaterスタック**: アプリケーションサービス

### 段階的デプロイ

#### Phase 1: インフラストラクチャ
```bash
npx cdk deploy dev-AdvasaBusinessBase-VPC --context env=dev
npx cdk deploy stg-AdvasaBusinessBase-VPC --context env=stg
npx cdk deploy prod-AdvasaBusinessBase-VPC --context env=prod
```

#### Phase 2: アプリケーション  
```bash
npx cdk deploy dev-AdvasaBusinessBase-ZenginDataUpdater --context env=dev
npx cdk deploy stg-AdvasaBusinessBase-ZenginDataUpdater --context env=stg
npx cdk deploy prod-AdvasaBusinessBase-ZenginDataUpdater --context env=prod
```

#### Phase 3: デプロイ後設定
```bash
# 各環境でデプロイ後、データベースセキュリティグループの設定が必要
# 詳細は「デプロイ後設定」セクションを参照
```

## 🌍 環境別デプロイ

### 開発環境 (dev)
- **自動デプロイ**: コード変更時の自動実行
- **デバッグ有効**: 詳細ログ出力
- **最小構成**: コスト最適化

### ステージング環境 (stg)  
- **手動承認**: デプロイ前の承認フロー
- **本番同等**: 本番環境と同じ構成
- **統合テスト**: 全機能テスト

### 本番環境 (prod)
- **多段階承認**: 複数承認者による承認
- **自動ロールバック**: 異常検知時の自動復旧  
- **高可用性**: 冗長化構成

## ⬅️ ロールバック手順

### Lambda関数のロールバック
```bash
# 前のバージョンに戻す
aws lambda update-alias \
  --function-name dev-zengin-diff-processor \
  --name LIVE \
  --function-version 2
```

### CloudFormationスタックのロールバック
```bash
# 前のバージョンにロールバック
aws cloudformation continue-update-rollback \
  --stack-name dev-AdvasaBusinessBase-ZenginDataUpdater
```

## 📊 監視とアラート

### 重要度別アラート
- **P1 (Critical)**: Lambda error rate > 10%, DynamoDB throttling
- **P2 (High)**: Lambda error rate > 5%, Lambda duration > 30s  
- **P3 (Medium)**: Lambda cold starts > 20%, S3 PUT errors

## ⚙️ デプロイ後設定

### データベースセキュリティグループの設定

**重要**: 各環境でのデプロイ後、本システムのデータベースセキュリティグループにLambda関数のセキュリティグループからのアクセスを許可する必要があります。

#### 必要な設定手順

1. **Lambda セキュリティグループIDの取得**
```bash
# 環境に応じて env を変更（dev/stg/prod）
export ENV=dev

# Lambda セキュリティグループIDを取得
LAMBDA_SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=${ENV}-AdvasaBusinessBase-Lambda-SG" \
  --query 'SecurityGroups[0].GroupId' \
  --output text)

echo "Lambda Security Group ID: $LAMBDA_SG_ID"
```

2. **データベースセキュリティグループIDの取得**
```bash
# データベースのセキュリティグループIDを取得
# 実際のデータベースのセキュリティグループ名に置き換えてください
DB_SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=your-database-security-group-name" \
  --query 'SecurityGroups[0].GroupId' \
  --output text)

echo "Database Security Group ID: $DB_SG_ID"
```

3. **インバウンドルールの追加**
```bash
# PostgreSQLポート（5432）へのアクセスを許可
aws ec2 authorize-security-group-ingress \
  --group-id $DB_SG_ID \
  --protocol tcp \
  --port 5432 \
  --source-group $LAMBDA_SG_ID \
  --description "Allow Lambda functions to access PostgreSQL database"
```

#### 環境別設定例

**開発環境 (dev)**
```bash
export ENV=dev
# 上記手順を実行
```

**ステージング環境 (stg)**
```bash
export ENV=stg
# 上記手順を実行
```

**本番環境 (prod)**
```bash
export ENV=prod
# 上記手順を実行
```

#### 設定確認

```bash
# セキュリティグループのインバウンドルールを確認
aws ec2 describe-security-groups \
  --group-ids $DB_SG_ID \
  --query 'SecurityGroups[0].IpPermissions' \
  --output table
```

### 注意事項

- この設定は各環境で1回のみ実行してください
- 既にルールが存在する場合はエラーになりますが、問題ありません
- データベースのセキュリティグループ名は実際の環境に応じて調整してください

## 🔧 運用手順

### 日常運用
```bash
# ログ確認
aws logs tail /aws/lambda/dev-zengin-diff-processor --follow

# DynamDB データ確認
aws dynamodb scan --table-name zengin-data-diff-dev

# 手動実行
aws lambda invoke \
  --function-name dev-zengin-diff-processor \
  --payload '{"trigger": "manual"}' response.json
```

### 緊急時対応
```bash
# Lambda関数の停止
aws lambda put-function-concurrency \
  --function-name dev-zengin-diff-processor \
  --reserved-concurrent-executions 0

# EventBridge スケジュール無効化
aws scheduler update-schedule \
  --name zengin-daily-check-dev \
  --group-name zengin-data-updater-dev \
  --state DISABLED
```

## 🔍 トラブルシューティング

### よくある問題

#### Lambda VPC接続タイムアウト
```
Error: Task timed out after X seconds
```
**解決方法**: VPCエンドポイント設定確認、メモリサイズ増加

#### DynamoDB スロットリング
```
Error: ProvisionedThroughputExceededException
```
**解決方法**: 課金モード確認、キャパシティ設定調整

#### psycopg2 インポートエラー
```
Error: No module named 'psycopg2'
```
**解決方法**: `layers/psycopg2/build.sh` を実行してレイヤー再作成

このガイドに従い、適切なコマンドを実行してAdvasaBusinessBaseプロジェクトをデプロイしてください。