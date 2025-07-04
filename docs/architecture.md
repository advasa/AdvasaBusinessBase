# AdvasaBusinessBase - システムアーキテクチャ

## 📋 目次

- [アーキテクチャ概要](#アーキテクチャ概要)
- [レイヤー構成](#レイヤー構成)
- [マイクロサービス詳細](#マイクロサービス詳細)
- [データフロー](#データフロー)
- [セキュリティアーキテクチャ](#セキュリティアーキテクチャ)
- [監視・可観測性](#監視可観測性)
- [スケーラビリティ](#スケーラビリティ)
- [設計原則](#設計原則)

## 🏗️ アーキテクチャ概要

AdvasaBusinessBaseは、イベント駆動型のマイクロサービスアーキテクチャを採用し、AWS上でサーバーレス・コンテナレス設計により高可用性とコスト効率を実現しています。

### 全体アーキテクチャ図

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       AdvasaBusinessBase                                │
│                   Event-Driven Microservices                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                   API Gateway Layer                            │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │   │
│  │  │   Slack     │  │   Health    │  │   Future    │           │   │
│  │  │   Events    │  │   Check     │  │   APIs      │           │   │
│  │  │     API     │  │     API     │  │             │           │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                │                                        │
│                                ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                  Lambda Functions Layer                        │   │
│  │                                                                 │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │   │
│  │  │   Slack      │  │   Slack      │  │   Zengin     │        │   │
│  │  │   Events     │  │ Interactive  │  │    Diff      │        │   │
│  │  │   Handler    │  │   Handler    │  │  Processor   │        │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘        │   │
│  │           │                  │               │                │   │
│  │           ▼                  ▼               ▼                │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │   │
│  │  │   Callback   │  │   Diff       │  │   Future     │        │   │
│  │  │   Handler    │  │  Executor    │  │  Functions   │        │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                │                                        │
│                                ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                   Data & Storage Layer                         │   │
│  │                                                                 │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │   │
│  │  │  DynamoDB   │  │     S3      │  │ PostgreSQL  │           │   │
│  │  │ Diff Tables │  │Diff Storage │  │(advasa-db)  │           │   │
│  │  │   (NoSQL)   │  │  (Object)   │  │ (Relational)│           │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                │                                        │
│                                ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                Integration & Orchestration                      │   │
│  │                                                                 │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │   │
│  │  │ EventBridge │  │   Secrets   │  │ CloudWatch  │           │   │
│  │  │ Schedulers  │  │  Manager    │  │  Monitoring │           │   │
│  │  │(Orchestrate)│  │ (Security)  │  │(Observab.)  │           │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## 📚 レイヤー構成

### 1. API Gateway Layer (エントリーポイント)

**目的**: 外部システム（Slack）からのリクエストを受信し、適切なLambda関数にルーティング

**コンポーネント**:
- **Slack Events API**: Slack Events APIからのWebhook受信
- **Slack Interactive API**: Slackインタラクティブコンポーネントからのイベント受信
- **Health Check API**: システムヘルスチェック

**技術仕様**:
```typescript
// API Gateway 設定
apiGateway = new ApiGatewayConstruct(this, 'SlackApi', {
  apiName: `${config.env}-zengin-slack-api`,
  stage: 'v1',
  throttleRateLimit: 100,      // 100 req/sec
  throttleBurstLimit: 200,     // バースト 200 req
  enableCors: true,
  enableLogging: true,
});
```

**セキュリティ**:
- Slack署名検証による認証
- レート制限によるDDoS防止
- CORS設定による適切なオリジン制御

### 2. Compute Layer (ビジネスロジック)

**目的**: ビジネスロジックの実行、データ処理、外部システム統合

#### Lambda関数構成

| 関数名 | 役割 | トリガー | 実行環境 |
|--------|------|----------|----------|
| `slack-events` | Slack Events API処理 | API Gateway | VPC内プライベート |
| `slack-interactive` | Slackインタラクティブ処理 | API Gateway | VPC内プライベート |
| `zengin-diff-processor` | 全銀データ差分検出 | EventBridge (daily) | VPC内プライベート |
| `zengin-callback-handler` | 承認フロー処理 | Manual Invoke | VPC内プライベート |
| `zengin-diff-executor` | 差分実行処理 | EventBridge (dynamic) | VPC内プライベート |

#### VPC配置設計

```
┌─────────────────────────────────────────────────────────┐
│                    Advasa VPC                           │
│                                                         │
│  ┌───────────────────────┐  ┌───────────────────────┐   │
│  │   Private Subnet A    │  │   Private Subnet B    │   │
│  │                       │  │                       │   │
│  │  ┌─────────────────┐  │  │  ┌─────────────────┐  │   │
│  │  │ Lambda Functions│  │  │  │     RDS         │  │   │
│  │  │ ┌─────────────┐ │  │  │  │ (advasa-django) │  │   │
│  │  │ │Events       │ │  │  │  └─────────────────┘  │   │
│  │  │ │Interactive  │ │  │  │                       │   │
│  │  │ │DiffProcessor│ │  │  │  ┌─────────────────┐  │   │
│  │  │ │Callback     │ │  │  │  │Security Groups  │  │   │
│  │  │ │Executor     │ │  │  │  │DB Access        │  │   │
│  │  │ └─────────────┘ │  │  │  └─────────────────┘  │   │
│  │  └─────────────────┘  │  │                       │   │
│  └───────────────────────┘  └───────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐ │
│  │                VPC Endpoints                        │ │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐│ │
│  │ │Secrets   │ │CloudWatch│ │EventBridge│ │Lambda   ││ │
│  │ │Manager   │ │Logs      │ │Scheduler  │ │Service  ││ │
│  │ └──────────┘ └──────────┘ └──────────┘ └──────────┘│ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 3. Data & Storage Layer (データ永続化)

**目的**: データの永続化、検索、スケーラブルストレージ

#### DynamoDB設計

**テーブル**: `zengin-data-diff-{env}`

```json
{
  "TableName": "zengin-data-diff-dev",
  "KeySchema": [
    {
      "AttributeName": "id",
      "KeyType": "HASH"          // パーティションキー
    },
    {
      "AttributeName": "timestamp", 
      "KeyType": "RANGE"         // ソートキー
    }
  ],
  "GlobalSecondaryIndexes": [
    {
      "IndexName": "StatusIndex",
      "KeySchema": [
        {
          "AttributeName": "status",
          "KeyType": "HASH"
        },
        {
          "AttributeName": "timestamp",
          "KeyType": "RANGE"
        }
      ]
    }
  ],
  "BillingMode": "PAY_PER_REQUEST",
  "PointInTimeRecoverySpecification": {
    "PointInTimeRecoveryEnabled": true   // 本番環境のみ
  },
  "TimeToLiveSpecification": {
    "AttributeName": "ttl",
    "Enabled": true
  }
}
```

**アクセスパターン**:
1. **差分作成**: `PutItem` by `id`
2. **状態更新**: `UpdateItem` by `id` + `timestamp`
3. **状態別取得**: `Query` on `StatusIndex`
4. **期限切れ削除**: TTL by `ttl` attribute

#### S3設計

**バケット**: `{env}-zengin-diff-data`

```typescript
const bucket = new s3.Bucket(this, 'DiffDataBucket', {
  versioned: true,
  encryption: s3.BucketEncryption.S3_MANAGED,
  lifecycleRules: [
    {
      id: 'DeleteOldDiffs',
      enabled: true,
      expiration: cdk.Duration.days(90),      // 90日で削除
      noncurrentVersionExpiration: cdk.Duration.days(30),
    },
  ],
});
```

**用途**:
- 大容量差分データ (>400KB) の保存
- バイナリ形式データの保存
- 履歴データのアーカイブ

### 4. Integration & Orchestration Layer (統合・調整)

**目的**: サービス間連携、スケジューリング、セキュリティ、監視

#### EventBridge Scheduler

**日次スケジュール**:
```json
{
  "ScheduleExpression": "cron(0 23 * * ? *)",  // 本番: 23:00
  "ScheduleExpressionTimezone": "Asia/Tokyo",
  "Target": {
    "Arn": "arn:aws:lambda:region:account:function:zengin-diff-processor",
    "Input": "{\"trigger\": \"daily\"}"
  }
}
```

**動的スケジュール** (ワンタイム実行):
```json
{
  "ScheduleExpression": "at(2024-01-01T23:00:00)",
  "Target": {
    "Arn": "arn:aws:lambda:region:account:function:zengin-diff-executor",
    "Input": "{\"diffId\": \"diff-20240101-001\"}"
  }
}
```

## 🔧 マイクロサービス詳細

### Zengin Data Updater サービス

#### データフロー詳細

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Zengin Data Updater Flow                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐ ①Daily Trigger ┌─────────────────────────────────────┐ │
│  │ EventBridge │────────────────▶│        Diff Processor              │ │
│  │ Scheduler   │                 │                                     │ │
│  └─────────────┘                 │ ┌─ Fetch Zengin Data              │ │
│                                  │ ├─ Fetch Current DB Data          │ │
│                                  │ ├─ Compare & Generate Diff        │ │
│                                  │ ├─ Store to DynamoDB             │ │
│                                  │ └─ Large Data → S3               │ │
│                                  └─────────────────────────────────────┘ │
│                                                  │                      │
│                                                  ▼ ②Slack Notification   │
│                ┌─────────────────────────────────────────────────────────┐ │
│                │                     Slack                              │ │
│                │ ┌─────────────────────────────────────────────────────┐ │ │
│                │ │  📊 差分検出通知                                     │ │ │
│                │ │  ┌─ 追加: 3件                                      │ │ │
│                │ │  ├─ 更新: 2件                                      │ │ │
│                │ │  └─ 削除: 1件                                      │ │ │
│                │ │                                                   │ │ │
│                │ │  [承認] [却下] [実行時刻選択]                       │ │ │
│                │ └─────────────────────────────────────────────────────┘ │ │
│                └─────────────────────────────────────────────────────────┘ │
│                                  │                                        │
│                                  ▼ ③User Interaction                      │
│  ┌─────────────┐                ┌─────────────────────────────────────┐   │
│  │API Gateway  │◄───────────────│        Slack Interactive           │   │
│  │             │                │                                     │   │
│  │/interactive │                │ ┌─ Parse Slack Payload              │   │
│  │            │                │ ├─ Validate Signature               │   │
│  │            │                │ └─ Route to Callback Handler        │   │
│  └─────────────┘                └─────────────────────────────────────┘   │
│        │                                         │                        │
│        ▼ ④Route to Handler                       ▼                        │
│  ┌─────────────────────────────────────┐  ┌─────────────────────────────┐ │
│  │        Callback Handler            │  │    Update DynamoDB          │ │
│  │                                     │  │                             │ │
│  │ ┌─ Process Approval/Rejection      │  │ ┌─ Status: approved         │ │
│  │ ├─ Parse Schedule Selection        │  │ ├─ Approved By: user@...     │ │
│  │ ├─ Create EventBridge Schedule     │  │ ├─ Schedule Time: 23:00      │ │
│  │ └─ Update DynamoDB Status          │  │ └─ TTL: +90 days             │ │
│  └─────────────────────────────────────┘  └─────────────────────────────┘ │
│                     │                                                    │
│                     ▼ ⑤Create One-time Schedule                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                 EventBridge Scheduler                               │ │
│  │                                                                     │ │
│  │ ┌─ Schedule: at(2024-01-01T23:00:00)                              │ │
│  │ ├─ Target: zengin-diff-executor                                   │ │
│  │ ├─ Payload: {"diffId": "diff-20240101-001"}                      │ │
│  │ └─ Execution: One-time only                                      │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│                                    ▼ ⑥Scheduled Execution                │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                     Diff Executor                                   │ │
│  │                                                                     │ │
│  │ ┌─ Retrieve Diff from DynamoDB                                    │ │
│  │ ├─ Large Data from S3 (if needed)                               │ │
│  │ ├─ Connect to PostgreSQL (advasa-django)                        │ │
│  │ ├─ Execute SQL Transactions                                      │ │
│  │ ├─ Update Execution Status                                       │ │
│  │ └─ Send Completion Notification                                  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│                                    ▼ ⑦Completion Notification            │
│                ┌─────────────────────────────────────────────────────────┐ │
│                │                     Slack                              │ │
│                │ ┌─────────────────────────────────────────────────────┐ │ │
│                │ │  ✅ 更新完了通知                                     │ │ │
│                │ │  ┌─ 処理時刻: 2024-01-01 23:00:15                  │ │ │
│                │ │  ├─ 処理件数: 6件 (追加3, 更新2, 削除1)             │ │ │
│                │ │  ├─ 実行時間: 2.3秒                                │ │ │
│                │ │  └─ ステータス: 成功                                │ │ │
│                │ └─────────────────────────────────────────────────────┘ │ │
│                └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

#### エラーハンドリング & 復旧戦略

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Error Handling Strategy                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐  Retry Strategy  ┌─────────────────────────────────┐ │
│  │ Lambda Function │◄────────────────►│        Dead Letter Queue       │ │
│  │                 │                  │                                 │ │
│  │ ┌─ Max Retries: 3              │  │ ┌─ Failed Events Storage       │ │
│  │ ├─ Backoff: Exponential       │  │ ├─ TTL: 14 days                │ │
│  │ ├─ Initial: 1s, 2s, 4s        │  │ ├─ Manual Replay Capability    │ │
│  │ └─ Circuit Breaker            │  │ └─ Alarm Integration            │ │
│  └─────────────────┘                  └─────────────────────────────────┘ │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                      CloudWatch Alarms                             │ │
│  │                                                                     │ │
│  │ ┌─ Lambda Errors > 5%                                             │ │
│  │ ├─ Lambda Duration > 30s                                          │ │
│  │ ├─ DynamoDB Throttling                                            │ │
│  │ ├─ External API Failures                                          │ │
│  │ └─ Automatic SNS → Slack Notifications                           │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## 🔒 セキュリティアーキテクチャ

### ネットワークセキュリティ

#### VPC分離設計

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Security Architecture                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                      Internet Gateway                              │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                       Public Subnets                               │ │
│  │                                                                     │ │
│  │ ┌─────────────┐  ┌─────────────┐                                   │ │
│  │ │    NAT      │  │    ALB      │  ← Only for future services      │ │
│  │ │  Gateway A  │  │  (Future)   │                                   │ │
│  │ └─────────────┘  └─────────────┘                                   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                    │                                                    │
│                    ▼                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                      Private Subnets                               │ │
│  │                                                                     │ │
│  │ ┌─────────────────────────────────────────────────────────────────┐ │ │
│  │ │                   Lambda Functions                             │ │ │
│  │ │                                                                 │ │ │
│  │ │ ┌─ All Functions in Private Subnets                           │ │ │
│  │ │ ├─ No Direct Internet Access                                  │ │ │
│  │ │ ├─ VPC Endpoints for AWS Service Access                      │ │ │
│  │ │ └─ Database Access via Security Groups                       │ │ │
│  │ └─────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                     │ │
│  │ ┌─────────────────────────────────────────────────────────────────┐ │ │
│  │ │                    Database Layer                               │ │ │
│  │ │                                                                 │ │ │
│  │ │ ┌─ RDS PostgreSQL (Private)                                    │ │ │
│  │ │ ├─ Security Group: Lambda → DB                                 │ │ │
│  │ │ ├─ Encryption at Rest                                          │ │ │
│  │ │ └─ Encryption in Transit                                       │ │ │
│  │ └─────────────────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                       VPC Endpoints                                │ │
│  │                                                                     │ │
│  │ ┌─ Secrets Manager    ├─ CloudWatch Logs  ├─ EventBridge          │ │
│  │ ├─ CloudWatch        ├─ EventBridge Scheduler ├─ Lambda Service   │ │
│  │ ├─ S3 Gateway        ├─ DynamoDB Gateway                          │ │
│  │ └─ All AWS API calls routed through PrivateLink                   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### 認証・認可

#### Slack署名検証プロセス

```python
def validate_slack_signature(headers: dict, body: str, secret: str) -> bool:
    """
    Slack署名検証の実装
    """
    timestamp = headers.get('X-Slack-Request-Timestamp')
    signature = headers.get('X-Slack-Signature')
    
    # Replay attack防止 (5分以内のリクエストのみ許可)
    if abs(time.time() - int(timestamp)) > 300:
        return False
    
    # 署名生成
    basestring = f"v0:{timestamp}:{body}"
    expected_signature = 'v0=' + hmac.new(
        secret.encode(),
        basestring.encode(),
        hashlib.sha256
    ).hexdigest()
    
    # 定数時間比較でタイミング攻撃を防止
    return hmac.compare_digest(signature, expected_signature)
```

#### IAM権限設計 (最小権限の原則)

```typescript
// Diff Processor Lambda 権限
const diffProcessorPolicy = new iam.PolicyStatement({
  actions: [
    'dynamodb:PutItem',           // 差分データ作成
    'dynamodb:GetItem',           // 差分データ取得
    's3:PutObject',               // 大容量データ保存
    'secretsmanager:GetSecretValue', // DB認証情報取得
  ],
  resources: [
    this.diffTable.tableArn,
    `${diffDataBucket.bucketArn}/*`,
    config.database.secretArn,
    zenginConfig.slack.botTokenSecret,
  ],
});

// Callback Handler Lambda 権限
const callbackHandlerPolicy = new iam.PolicyStatement({
  actions: [
    'dynamodb:UpdateItem',        // 状態更新
    'scheduler:CreateSchedule',   // スケジュール作成
    'iam:PassRole',              // Schedulerロール権限委譲
  ],
  resources: [
    this.diffTable.tableArn,
    `arn:aws:scheduler:*:*:schedule/*`,
    this.eventBridge.schedulerRole.roleArn,
  ],
});
```

### データ保護

#### 暗号化設計

**保存時暗号化**:
- **DynamoDB**: AWS KMS カスタマーマネージドキー
- **S3**: AES-256暗号化 (S3 Managed)
- **RDS**: 透明データ暗号化 (TDE)
- **Secrets Manager**: AWS KMSによる暗号化

**転送時暗号化**:
- **API Gateway**: TLS 1.2以上
- **Lambda ↔ RDS**: SSL/TLS接続強制
- **Lambda ↔ AWS Services**: HTTPS/TLS

## 📊 監視・可観測性

### 包括的監視アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Observability Architecture                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                       Metrics Layer                                │ │
│  │                                                                     │ │
│  │ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │ │
│  │ │   Lambda    │  │  DynamoDB   │  │API Gateway  │                │ │
│  │ │   Metrics   │  │   Metrics   │  │   Metrics   │                │ │
│  │ │             │  │             │  │             │                │ │
│  │ │ ・Duration  │  │ ・Throttles │  │ ・Latency   │                │ │
│  │ │ ・Errors    │  │ ・Consumed  │  │ ・4XX/5XX   │                │ │
│  │ │ ・Invokes   │  │ ・Capacity  │  │ ・Count     │                │ │
│  │ └─────────────┘  └─────────────┘  └─────────────┘                │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                        Logs Layer                                  │ │
│  │                                                                     │ │
│  │ ┌─ Structured JSON Logs                                           │ │
│  │ ├─ CloudWatch Log Groups per Lambda                               │ │
│  │ ├─ Log Retention: 14 days (dev), 30 days (prod)                  │ │
│  │ ├─ Log Insights Queries for Troubleshooting                      │ │
│  │ └─ Sensitive Data Masking                                         │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                      Tracing Layer                                 │ │
│  │                                                                     │ │
│  │ ┌─ X-Ray Distributed Tracing                                      │ │
│  │ ├─ Service Map Visualization                                      │ │
│  │ ├─ Performance Bottleneck Detection                               │ │
│  │ ├─ External API Call Monitoring                                   │ │
│  │ └─ Database Query Performance                                     │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                      Alerting Layer                                │ │
│  │                                                                     │ │
│  │ ┌─ CloudWatch Alarms                                              │ │
│  │ ├─ SNS → Slack Integration                                        │ │
│  │ ├─ PagerDuty Integration (prod)                                   │ │
│  │ ├─ Escalation Policies                                            │ │
│  │ └─ Runbook Links in Alerts                                        │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### アラート設定詳細

#### 重要度別アラート

**P1 (Critical)**:
- Lambda error rate > 10%
- DynamoDB throttling events
- Database connection failures
- API Gateway 5XX rate > 5%

**P2 (High)**:
- Lambda error rate > 5%
- Lambda duration > 30 seconds
- DynamoDB consumed capacity > 80%
- External API timeouts

**P3 (Medium)**:
- Lambda cold start rate > 20%
- S3 PUT errors
- CloudWatch log ingestion delays

## 🚀 スケーラビリティ

### Auto Scaling設計

#### Lambda同時実行制御

```typescript
const lambdaConfigs = {
  'zengin-diff-processor': {
    reservedConcurrency: 10,       // 同時実行数制限
    timeout: 900,                  // 15分タイムアウト
    memorySize: 1024,             // 1GB メモリ
  },
  'slack-interactive': {
    reservedConcurrency: 5,        // Slack API制限考慮
    timeout: 30,                   // 30秒タイムアウト
    memorySize: 512,              // 512MB メモリ
  },
};
```

#### DynamoDB Auto Scaling

```typescript
// プロビジョニングモード時の設定
const autoScalingSettings = {
  readCapacity: {
    minCapacity: 5,
    maxCapacity: 100,
    targetUtilization: 70,
  },
  writeCapacity: {
    minCapacity: 5,
    maxCapacity: 200,
    targetUtilization: 70,
  },
};
```

### 性能最適化

#### Cold Start対策

1. **Provisioned Concurrency** (本番環境)
2. **Lambda Layer最適化** (共通ライブラリ)
3. **VPC ENI ウォームアップ**
4. **メモリサイズ最適化**

#### 大容量データ処理

```python
def handle_large_diff_data(diff_data: dict) -> str:
    """
    大容量差分データの効率的処理
    """
    # サイズチェック (400KB以上はS3に保存)
    if len(json.dumps(diff_data).encode()) > 400 * 1024:
        # S3に保存
        s3_key = f"diffs/{diff_data['id']}.json"
        s3_client.put_object(
            Bucket=S3_BUCKET_NAME,
            Key=s3_key,
            Body=json.dumps(diff_data),
            ContentType='application/json'
        )
        
        # DynamoDBには参照のみ保存
        return {
            'id': diff_data['id'],
            'data_location': f's3://{S3_BUCKET_NAME}/{s3_key}',
            'size': len(json.dumps(diff_data)),
            'summary': diff_data.get('summary', {})
        }
    else:
        # DynamoDBに直接保存
        return diff_data
```

## 📐 設計原則

### 1. 単一責任の原則 (Single Responsibility)

各Lambda関数は明確に定義された単一の責任を持ちます：

- **Events Handler**: Slack Events APIの処理のみ
- **Interactive Handler**: Slackインタラクティブコンポーネントの処理のみ
- **Diff Processor**: 差分検出処理のみ
- **Callback Handler**: 承認フロー処理のみ
- **Diff Executor**: 差分実行処理のみ

### 2. 疎結合アーキテクチャ (Loose Coupling)

サービス間の依存関係を最小化：

- **非同期通信**: EventBridge経由のイベント駆動
- **データ分離**: 各サービス独自のデータストレージ
- **API契約**: 明確に定義されたインターフェース

### 3. 高可用性 (High Availability)

- **Multi-AZ配置**: 複数アベイラビリティーゾーン
- **自動フェイルオーバー**: AWSサービスの冗長性活用
- **Graceful degradation**: 部分的障害時の優雅な縮退

### 4. セキュリティ・バイ・デザイン

- **Defense in Depth**: 多層防御戦略
- **Principle of Least Privilege**: 最小権限の原則
- **Encryption Everywhere**: 全レイヤーでの暗号化

### 5. 運用性 (Operability)

- **Infrastructure as Code**: CDKによる宣言的インフラ
- **Automated Deployment**: CI/CDパイプライン
- **Comprehensive Monitoring**: 包括的な監視・アラート

この設計により、AdvasaBusinessBaseは**拡張性**、**可用性**、**セキュリティ**、**運用性**を両立した堅牢なマイクロサービスプラットフォームを実現しています。