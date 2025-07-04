# AdvasaBusinessBase プロジェクト専用ガイドライン

## 重要: ビルドコマンドについて

このプロジェクトでタスクを実行する際、ビルドコマンドやデプロイコマンドは自動的に実行しないでください。
代わりに、必要なコマンドをユーザーに提示してください。

### デプロイコマンド例

CDKスタックをデプロイする場合：
```bash
# 全スタックをデプロイ
npx cdk deploy --all --context env=dev

# 特定のスタックのみデプロイ
npx cdk deploy dev-AdvasaBusinessBase-ZenginDataUpdater --context env=dev

# VPCスタックをデプロイ
npx cdk deploy dev-AdvasaBusinessBase-VPC --context env=dev
```

### テストコマンド例

Lambda関数をテストする場合：
```bash
# Lambda関数を直接実行
aws lambda invoke --function-name dev-zengin-diff-processor response.json
```

### 注意事項

1. タスク実行時は、まず変更内容を説明してください
2. その後、実行すべきコマンドを明示的に表示してください
3. ユーザーの確認を待ってください
4. ビルドやデプロイコマンドを自動的に実行しないでください

## プロジェクト固有の設定

### psycopg2レイヤーについて

このプロジェクトでは、Lambda関数でPostgreSQLに接続するためにpsycopg2-binaryを使用しています。
ただし、macOSで作成したレイヤーはAWS Lambda (Linux x86_64)では動作しません。

正しいレイヤーを作成するには、Dockerを使用してください：
```bash
cd layers/psycopg2
docker run --rm -v "$PWD":/var/task public.ecr.aws/lambda/python:3.11 \
  pip install psycopg2-binary==2.9.9 -t /var/task/python/
```

### VPCエンドポイントについて

Lambda関数はVPC内のプライベートサブネットで実行されるため、AWSサービスにアクセスするには以下のVPCエンドポイントが必要です：

- Secrets Manager
- CloudWatch Logs
- CloudWatch (monitoring)
- EventBridge
- EventBridge Scheduler
- Lambda

これらはVPCスタック（vpc-construct.ts）で自動的に作成されます。