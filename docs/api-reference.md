# AdvasaBusinessBase - API仕様書

## 📋 目次

- [API概要](#api概要)
- [認証・認可](#認証認可)
- [Slack Events API](#slack-events-api)
- [Slack Interactive API](#slack-interactive-api)
- [ヘルスチェックAPI](#ヘルスチェックapi)
- [エラーハンドリング](#エラーハンドリング)
- [レート制限](#レート制限)
- [監視・ログ](#監視ログ)

## 🌐 API概要

AdvasaBusinessBaseは、AWS API Gatewayを通じてSlack統合のためのRESTful APIを提供します。

### ベースURL

```
https://{api-gateway-id}.execute-api.ap-northeast-1.amazonaws.com/v1/
```

### サポートプロトコル

- **HTTPS**: TLS 1.2以上
- **Content-Type**: `application/json`, `application/x-www-form-urlencoded`
- **HTTP Methods**: `GET`, `POST`

### API構成

| エンドポイント | メソッド | 用途 | Lambda関数 |
|------------|---------|------|-----------|
| `/events` | POST | Slack Events API | `slack-events` |
| `/interactive` | POST | Slack Interactive Components | `slack-interactive` |
| `/health` | GET | ヘルスチェック | 内蔵レスポンス |

## 🔐 認証・認可

### Slack署名検証

すべてのSlack APIエンドポイントで、リクエスト署名の検証を実装しています。

#### 署名検証プロセス

```python
def validate_slack_signature(headers: dict, body: str) -> bool:
    """
    Slack署名検証の実装
    """
    timestamp = headers.get('X-Slack-Request-Timestamp')
    signature = headers.get('X-Slack-Signature')
    
    # Replay attack防止 (5分以内のリクエストのみ許可)
    if abs(time.time() - int(timestamp)) > 300:
        return False
    
    # 署名生成・検証
    signing_secret = get_slack_signing_secret()
    basestring = f"v0:{timestamp}:{body}"
    expected_signature = 'v0=' + hmac.new(
        signing_secret.encode(),
        basestring.encode(),
        hashlib.sha256
    ).hexdigest()
    
    # 定数時間比較でタイミング攻撃を防止
    return hmac.compare_digest(signature, expected_signature)
```

#### 必須ヘッダー

```http
X-Slack-Request-Timestamp: 1531420618
X-Slack-Signature: v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503
Content-Type: application/json
```

## 📢 Slack Events API

### エンドポイント

```
POST /events
```

### 概要

SlackワークスペースからのイベントWebhookを受信し、適切に処理します。

### リクエスト形式

#### URL Verification (初回設定時)

```json
{
  "token": "Jhj5dZrVaK7ZwHHjRyZWjbDl",
  "challenge": "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
  "type": "url_verification"
}
```

#### Event Callback

```json
{
  "token": "XXYYZZ",
  "team_id": "TXXXXXXXX",
  "api_app_id": "AXXXXXXXXX",
  "event": {
    "type": "message",
    "channel": "C2147483705",
    "user": "U2147483697",
    "text": "Hello world",
    "ts": "1355517523.000005"
  },
  "type": "event_callback",
  "event_id": "Ev08MFMKH6",
  "event_time": 1234567890
}
```

### レスポンス形式

#### URL Verification Response

```json
{
  "challenge": "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P"
}
```

**HTTPステータス**: `200 OK`

#### Event Callback Response

```json
{
  "status": "success",
  "message": "Event processed successfully"
}
```

**HTTPステータス**: `200 OK`

### サポートイベント

| イベントタイプ | 説明 | 処理内容 |
|-------------|------|----------|
| `url_verification` | エンドポイント検証 | チャレンジレスポンス |
| `message.channels` | チャンネルメッセージ | メッセージ処理 |
| `message.groups` | プライベートチャンネルメッセージ | メッセージ処理 |
| `message.im` | ダイレクトメッセージ | メッセージ処理 |
| `message.mpim` | マルチパーティーIM | メッセージ処理 |

### エラーレスポンス

#### 署名検証失敗

```json
{
  "error": "invalid_signature",
  "message": "Request signature verification failed"
}
```

**HTTPステータス**: `401 Unauthorized`

#### 不正なペイロード

```json
{
  "error": "invalid_payload",
  "message": "Request payload is malformed or missing required fields"
}
```

**HTTPステータス**: `400 Bad Request`

## 🔄 Slack Interactive API

### エンドポイント

```
POST /interactive
```

### 概要

Slackインタラクティブコンポーネント（ボタン、セレクトメニュー等）からのユーザー操作を処理します。

### リクエスト形式

#### Button Interaction

```json
{
  "type": "block_actions",
  "user": {
    "id": "U061F7AUR",
    "username": "john.doe",
    "name": "john.doe"
  },
  "api_app_id": "A0MDYCDME",
  "token": "9s8d9as89d8as9d8as989",
  "container": {
    "type": "message"
  },
  "trigger_id": "13345224609.738474920.8088930838d88f008e0",
  "team": {
    "id": "T061EG9R6",
    "domain": "example"
  },
  "channel": {
    "id": "C0LAN2Q65",
    "name": "general"
  },
  "response_url": "https://hooks.slack.com/actions/1234567890/0987654321/xyz",
  "actions": [
    {
      "action_id": "approve_diff",
      "block_id": "diff_block",
      "text": {
        "type": "plain_text",
        "text": "承認"
      },
      "value": "diff-20240101-001",
      "type": "button",
      "action_ts": "1548426417.840180"
    }
  ]
}
```

#### Select Menu Interaction

```json
{
  "type": "block_actions",
  "user": {
    "id": "U061F7AUR",
    "username": "john.doe"
  },
  "api_app_id": "A0MDYCDME",
  "token": "9s8d9as89d8as9d8as989",
  "container": {
    "type": "message"
  },
  "trigger_id": "13345224609.738474920.8088930838d88f008e0",
  "team": {
    "id": "T061EG9R6",
    "domain": "example"
  },
  "channel": {
    "id": "C0LAN2Q65",
    "name": "general"
  },
  "actions": [
    {
      "action_id": "schedule_select",
      "block_id": "schedule_block",
      "selected_option": {
        "text": {
          "type": "plain_text",
          "text": "23:00実行"
        },
        "value": "daily"
      },
      "type": "static_select",
      "action_ts": "1548426417.840180"
    }
  ]
}
```

### レスポンス形式

#### 即座レスポンス

```json
{
  "response_type": "ephemeral",
  "text": "処理を開始しました。完了時に通知します。",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "✅ 差分承認を受け付けました。\n実行時刻: 23:00"
      }
    }
  ]
}
```

**HTTPステータス**: `200 OK`

#### エラーレスポンス

```json
{
  "response_type": "ephemeral",
  "text": "❌ エラーが発生しました。管理者にお問い合わせください。",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*エラー詳細:*\n差分ID `diff-20240101-001` が見つかりませんでした。"
      }
    }
  ]
}
```

**HTTPステータス**: `200 OK`

### サポートアクション

#### 承認・却下アクション

| Action ID | 説明 | 処理内容 |
|-----------|------|----------|
| `approve_diff` | 差分承認 | DynamoDB状態更新、スケジュール作成 |
| `reject_diff` | 差分却下 | DynamoDB状態更新、理由記録 |

#### スケジュール選択

| Value | 説明 | 実行タイミング |
|-------|------|----------------|
| `immediate` | 即時実行 | 現在時刻+1分 |
| `daily` | 23:00実行 | 当日または翌日23:00 |
| `1hour` | 1時間後 | 現在時刻+1時間 |
| `3hour` | 3時間後 | 現在時刻+3時間 |
| `5hour` | 5時間後 | 現在時刻+5時間 |

### 処理フロー

```
[User Interaction] 
        ↓
[Slack Interactive API]
        ↓
[Signature Validation]
        ↓
[Payload Parsing]
        ↓ 
[Action Type Detection]
        ↓
[Business Logic Processing]
        ├─ DynamoDB Update
        ├─ EventBridge Schedule Creation
        └─ Callback Handler Invocation
        ↓
[Response Generation]
        ↓
[Slack Response]
```

## ❤️ ヘルスチェックAPI

### エンドポイント

```
GET /health
```

### 概要

API Gatewayとバックエンドサービスの健全性を確認します。

### リクエスト形式

```http
GET /health HTTP/1.1
Host: {api-gateway-id}.execute-api.ap-northeast-1.amazonaws.com
```

### レスポンス形式

#### 正常時

```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "version": "1.0.0",
  "services": {
    "api_gateway": "healthy",
    "lambda_functions": {
      "slack_events": "healthy",
      "slack_interactive": "healthy"
    }
  },
  "region": "ap-northeast-1",
  "environment": "dev"
}
```

**HTTPステータス**: `200 OK`

#### 異常時

```json
{
  "status": "unhealthy",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "version": "1.0.0",
  "services": {
    "api_gateway": "healthy",
    "lambda_functions": {
      "slack_events": "unhealthy",
      "slack_interactive": "healthy"
    }
  },
  "errors": [
    "Lambda function slack-events is not responding"
  ],
  "region": "ap-northeast-1",
  "environment": "dev"
}
```

**HTTPステータス**: `503 Service Unavailable`

## ⚠️ エラーハンドリング

### 標準エラーレスポンス

すべてのAPIエンドポイントで統一されたエラーレスポンス形式を使用します。

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message",
    "details": {
      "field": "Additional error details",
      "timestamp": "2024-01-01T12:00:00.000Z",
      "request_id": "req-12345-67890"
    }
  }
}
```

### エラーコード一覧

| HTTPステータス | エラーコード | 説明 |
|-------------|------------|------|
| `400` | `INVALID_PAYLOAD` | リクエストペイロードが不正 |
| `401` | `INVALID_SIGNATURE` | Slack署名検証失敗 |
| `401` | `MISSING_SIGNATURE` | 署名ヘッダーが不足 |
| `403` | `FORBIDDEN` | アクセス権限なし |
| `404` | `ENDPOINT_NOT_FOUND` | エンドポイントが存在しない |
| `429` | `RATE_LIMIT_EXCEEDED` | レート制限に達した |
| `500` | `INTERNAL_SERVER_ERROR` | 内部サーバーエラー |
| `502` | `BAD_GATEWAY` | Lambda関数エラー |
| `503` | `SERVICE_UNAVAILABLE` | サービス利用不可 |
| `504` | `GATEWAY_TIMEOUT` | Lambda関数タイムアウト |

### Slackエラー処理

Slack APIからのエラーは、ユーザーフレンドリーなメッセージに変換して返却します。

#### 例: DynamoDB接続エラー

```json
{
  "response_type": "ephemeral",
  "text": "⚠️ 一時的にサービスが利用できません。しばらく後に再試行してください。",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*エラーID:* `req-12345-67890`\n*時刻:* 2024-01-01 12:00:00"
      }
    }
  ]
}
```

## 🚦 レート制限

### API Gateway制限

| 制限項目 | 開発環境 | 本番環境 | 単位 |
|----------|----------|----------|------|
| リクエストレート | 100 | 1000 | req/sec |
| バーストリミット | 200 | 2000 | req |
| 日次制限 | 100,000 | 1,000,000 | req/day |

### Lambda同時実行制限

| 関数名 | 予約済み同時実行数 | 説明 |
|--------|-------------------|------|
| `slack-events` | 5 | ENI問題対策 |
| `slack-interactive` | 5 | ENI問題対策 |
| `zengin-diff-processor` | 10 | 処理能力確保 |

### レート制限ヘッダー

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1609459200
```

### レート制限エラー

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded. Try again later.",
    "details": {
      "retry_after": 60,
      "limit": 100,
      "window": 60
    }
  }
}
```

**HTTPステータス**: `429 Too Many Requests`

## 📊 監視・ログ

### CloudWatch メトリクス

#### API Gateway メトリクス

| メトリクス名 | 説明 | アラート閾値 |
|------------|------|------------|
| `Count` | リクエスト数 | - |
| `Latency` | レスポンス時間 | > 5000ms |
| `4XXError` | クライアントエラー率 | > 10% |
| `5XXError` | サーバーエラー率 | > 5% |

#### Lambda メトリクス

| メトリクス名 | 説明 | アラート閾値 |
|------------|------|------------|
| `Invocations` | 実行回数 | - |
| `Errors` | エラー数 | > 5% |
| `Duration` | 実行時間 | > 30000ms |
| `Throttles` | スロットリング | > 0 |

### ログ形式

#### 構造化ログ

```json
{
  "timestamp": "2024-01-01T12:00:00.000Z",
  "level": "INFO",
  "service": "slack-events",
  "request_id": "req-12345-67890",
  "event": "slack_event_received",
  "data": {
    "event_type": "message",
    "channel": "C0LAN2Q65",
    "user": "U061F7AUR"
  },
  "duration_ms": 250
}
```

#### エラーログ

```json
{
  "timestamp": "2024-01-01T12:00:00.000Z",
  "level": "ERROR",
  "service": "slack-interactive",
  "request_id": "req-12345-67890",
  "event": "signature_validation_failed",
  "error": {
    "type": "SignatureValidationError",
    "message": "Invalid signature provided",
    "stack_trace": "..."
  },
  "context": {
    "headers": {
      "X-Slack-Request-Timestamp": "1609459200",
      "X-Slack-Signature": "v0=..."
    }
  }
}
```

### X-Ray分散トレーシング

各APIリクエストはX-Rayでトレースされ、以下の情報を記録します：

- API Gateway処理時間
- Lambda実行時間
- DynamoDB操作時間
- 外部API呼び出し時間
- エラー発生箇所

### アラート設定

#### Critical (P1)
- API Gateway 5XX error rate > 5%
- Lambda error rate > 10%
- Average response time > 10 seconds

#### High (P2)  
- API Gateway 4XX error rate > 15%
- Lambda error rate > 5%
- Average response time > 5 seconds

#### Medium (P3)
- Lambda cold start rate > 20%
- Request count drops > 50% from baseline

この仕様書に従って、Slack統合APIを適切に実装・運用してください。