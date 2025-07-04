# AdvasaBusinessBase - データベーススキーマ

## 📋 目次

- [概要](#概要)
- [DynamoDB設計](#dynamodb設計)
- [PostgreSQL連携](#postgresql連携)
- [データモデル](#データモデル)
- [アクセスパターン](#アクセスパターン)
- [パフォーマンス最適化](#パフォーマンス最適化)
- [データ保護・セキュリティ](#データ保護セキュリティ)

## 📊 概要

AdvasaBusinessBaseは、以下のデータストレージを使用してマイクロサービスアーキテクチャを実現しています：

### データストレージ構成

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Data Storage Architecture                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                        DynamoDB                                     │ │
│  │                     (Primary Storage)                              │ │
│  │                                                                     │ │
│  │  ┌─────────────────────────────────────────────────────────────────┤ │
│  │  │              zengin-data-diff-{env}                             │ │
│  │  │                                                                 │ │
│  │  │ ┌─ Primary Key: id (Partition) + timestamp (Sort)             │ │
│  │  │ ├─ GSI: StatusIndex (status + timestamp)                      │ │
│  │  │ ├─ TTL: ttl attribute (90 days)                               │ │
│  │  │ ├─ Point-in-Time Recovery (prod only)                         │ │
│  │  │ └─ Pay-per-Request Billing                                    │ │
│  │  └─────────────────────────────────────────────────────────────────┤ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                         S3 Storage                                 │ │
│  │                    (Large Data Objects)                            │ │
│  │                                                                     │ │
│  │  ┌─ Bucket: {env}-zengin-diff-data                                │ │
│  │  ├─ Versioning: Enabled                                           │ │
│  │  ├─ Encryption: AES-256                                           │ │
│  │  ├─ Lifecycle: 90 days → Delete                                   │ │
│  │  └─ Large diff data (>400KB) storage                              │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                     PostgreSQL RDS                                 │ │
│  │                  (Existing advasa-django)                          │ │
│  │                                                                     │ │
│  │  ┌─ Host: advasa-django database                                   │ │
│  │  ├─ Connection: Via VPC private subnet                            │ │
│  │  ├─ Authentication: Secrets Manager                               │ │
│  │  ├─ Target Tables: Bank/Branch master data                       │ │
│  │  └─ Transaction: ACID compliance                                  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## 🗄️ DynamoDB設計

### テーブル: zengin-data-diff-{env}

#### 基本設計

```json
{
  "TableName": "zengin-data-diff-dev",
  "AttributeDefinitions": [
    {
      "AttributeName": "id",
      "AttributeType": "S"
    },
    {
      "AttributeName": "timestamp",
      "AttributeType": "S"
    },
    {
      "AttributeName": "status",
      "AttributeType": "S"
    }
  ],
  "KeySchema": [
    {
      "AttributeName": "id",
      "KeyType": "HASH"
    },
    {
      "AttributeName": "timestamp", 
      "KeyType": "RANGE"
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
      ],
      "Projection": {
        "ProjectionType": "ALL"
      }
    }
  ],
  "BillingMode": "PAY_PER_REQUEST",
  "TimeToLiveSpecification": {
    "AttributeName": "ttl",
    "Enabled": true
  }
}
```

#### パーティション戦略

**パーティションキー設計**:
```
id = "diff-{YYYYMMDD}-{sequence}"

例:
- diff-20240101-001
- diff-20240101-002  
- diff-20240102-001
```

**利点**:
- 日付ベースの自然な分散
- 時系列データの効率的なアクセス
- ホットパーティション回避

### レコード構造

#### 基本差分レコード

```json
{
  "id": {
    "S": "diff-20240101-001"
  },
  "timestamp": {
    "S": "2024-01-01T09:00:00.000Z"
  },
  "status": {
    "S": "pending"
  },
  "diffType": {
    "S": "addition"
  },
  "zenginData": {
    "M": {
      "bankCode": {"S": "0001"},
      "bankName": {"S": "みずほ銀行"},
      "branchCode": {"S": "001"},
      "branchName": {"S": "本店"},
      "bankKana": {"S": "ミズホ"},
      "branchKana": {"S": "ホンテン"}
    }
  },
  "currentData": {
    "M": {
      "bankCode": {"S": "0001"},
      "bankName": {"S": "みずほ銀行"},
      "branchCode": {"S": "001"},
      "branchName": {"S": "本店営業部"},
      "bankKana": {"S": "ミズホ"},
      "branchKana": {"S": "ホンテンエイギョウブ"}
    }
  },
  "changes": {
    "M": {
      "branchName": {
        "M": {
          "old": {"S": "本店営業部"},
          "new": {"S": "本店"}
        }
      }
    }
  },
  "approvedBy": {
    "S": "user@example.com"
  },
  "approvedAt": {
    "S": "2024-01-01T10:30:00.000Z"
  },
  "executedAt": {
    "S": "2024-01-01T23:00:00.000Z"
  },
  "executionResult": {
    "M": {
      "success": {"BOOL": true},
      "rowsAffected": {"N": "1"},
      "executionTime": {"N": "250"}
    }
  },
  "metadata": {
    "M": {
      "source": {"S": "zengin-api"},
      "sourceVersion": {"S": "2024.01"},
      "processingNode": {"S": "lambda-001"}
    }
  },
  "ttl": {
    "N": "1712188800"
  }
}
```

#### 大容量データレコード (S3参照)

```json
{
  "id": {
    "S": "diff-20240101-002"
  },
  "timestamp": {
    "S": "2024-01-01T09:01:00.000Z"
  },
  "status": {
    "S": "pending"
  },
  "diffType": {
    "S": "bulk_update"
  },
  "dataLocation": {
    "S": "s3://dev-zengin-diff-data/diffs/diff-20240101-002.json"
  },
  "dataSize": {
    "N": "524288"
  },
  "dataSummary": {
    "M": {
      "totalRecords": {"N": "150"},
      "additions": {"N": "50"},
      "updates": {"N": "80"},
      "deletions": {"N": "20"}
    }
  },
  "ttl": {
    "N": "1712188800"
  }
}
```

### 状態遷移

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Record State Transitions                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  [diff created]                                                         │
│         │                                                               │
│         ▼                                                               │
│    ┌─────────┐                                                          │
│    │ pending │                                                          │
│    └─────────┘                                                          │
│         │                                                               │
│    [user action]                                                        │
│         │                                                               │
│         ├─────────────────┐                                             │
│         ▼                 ▼                                             │
│    ┌─────────┐       ┌─────────┐                                        │
│    │approved │       │rejected │                                        │
│    └─────────┘       └─────────┘                                        │
│         │                 │                                             │
│  [scheduled exec]         │                                             │
│         │                 │                                             │
│         ▼                 ▼                                             │
│    ┌─────────┐       ┌─────────┐                                        │
│    │executing│       │ expired │                                        │
│    └─────────┘       └─────────┘                                        │
│         │                                                               │
│    [exec result]                                                        │
│         │                                                               │
│         ├─────────────────┐                                             │
│         ▼                 ▼                                             │
│    ┌─────────┐       ┌─────────┐                                        │
│    │completed│       │ failed  │                                        │
│    └─────────┘       └─────────┘                                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Global Secondary Index: StatusIndex

#### 設計目的
状態別のレコード検索を効率化

#### Key Schema
```json
{
  "PartitionKey": "status",
  "SortKey": "timestamp"
}
```

#### アクセスパターン
```python
# 承認待ちレコードの取得
response = dynamodb.query(
    TableName='zengin-data-diff-dev',
    IndexName='StatusIndex',
    KeyConditionExpression='#status = :status',
    ExpressionAttributeNames={'#status': 'status'},
    ExpressionAttributeValues={':status': {'S': 'pending'}},
    ScanIndexForward=False,  # 新しい順
    Limit=50
)

# 実行中レコードの取得
response = dynamodb.query(
    TableName='zengin-data-diff-dev',
    IndexName='StatusIndex',
    KeyConditionExpression='#status = :status',
    ExpressionAttributeNames={'#status': 'status'},
    ExpressionAttributeValues={':status': {'S': 'executing'}}
)
```

### TTL (Time To Live)

#### 設定
```json
{
  "TimeToLiveSpecification": {
    "AttributeName": "ttl",
    "Enabled": true
  }
}
```

#### TTL値の計算
```python
import time

def calculate_ttl(days_from_now=90):
    """
    TTL値を計算 (90日後のUNIXタイムスタンプ)
    """
    return int(time.time()) + (days_from_now * 24 * 60 * 60)

# レコード作成時にTTLを設定
record['ttl'] = {'N': str(calculate_ttl(90))}
```

## 🐘 PostgreSQL連携

### 接続設定

#### Secrets Manager認証
```json
{
  "username": "advasa_user",
  "password": "secure_password_here",
  "host": "advasa-django-db.amazonaws.com",
  "port": 5432,
  "database": "advasa_db",
  "ssl": "require"
}
```

#### 接続プール設定
```python
import psycopg2
from psycopg2 import pool

# 接続プール作成
connection_pool = psycopg2.pool.ThreadedConnectionPool(
    minconn=1,
    maxconn=10,
    host=db_config['host'],
    port=db_config['port'],
    database=db_config['database'],
    user=db_config['username'],
    password=db_config['password'],
    sslmode='require'
)
```

### 対象テーブル

#### 銀行マスタテーブル

```sql
-- 銀行マスタ
CREATE TABLE banks (
    bank_code CHAR(4) PRIMARY KEY,
    bank_name VARCHAR(100) NOT NULL,
    bank_kana VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 支店マスタ  
CREATE TABLE branches (
    bank_code CHAR(4) NOT NULL,
    branch_code CHAR(3) NOT NULL,
    branch_name VARCHAR(100) NOT NULL,
    branch_kana VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (bank_code, branch_code),
    FOREIGN KEY (bank_code) REFERENCES banks(bank_code)
);

-- インデックス
CREATE INDEX idx_banks_name ON banks(bank_name);
CREATE INDEX idx_branches_name ON branches(branch_name);
CREATE INDEX idx_branches_bank ON branches(bank_code);
```

### トランザクション制御

#### 差分実行処理
```python
def execute_diff_changes(diff_data):
    """
    差分データをトランザクション内で実行
    """
    conn = None
    try:
        conn = connection_pool.getconn()
        conn.autocommit = False  # トランザクション開始
        
        cursor = conn.cursor()
        
        # 変更履歴の記録
        cursor.execute("""
            INSERT INTO change_history (diff_id, operation_type, table_name, record_id, old_values, new_values, executed_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (
            diff_data['id'],
            diff_data['diffType'],
            'banks',
            diff_data['bankCode'],
            json.dumps(diff_data['currentData']),
            json.dumps(diff_data['zenginData']),
            datetime.utcnow()
        ))
        
        # 実際のデータ更新
        if diff_data['diffType'] == 'addition':
            cursor.execute("""
                INSERT INTO banks (bank_code, bank_name, bank_kana, updated_at)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (bank_code) DO UPDATE SET
                    bank_name = EXCLUDED.bank_name,
                    bank_kana = EXCLUDED.bank_kana,
                    updated_at = EXCLUDED.updated_at
            """, (
                diff_data['zenginData']['bankCode'],
                diff_data['zenginData']['bankName'],
                diff_data['zenginData']['bankKana'],
                datetime.utcnow()
            ))
            
        elif diff_data['diffType'] == 'update':
            cursor.execute("""
                UPDATE banks 
                SET bank_name = %s, bank_kana = %s, updated_at = %s
                WHERE bank_code = %s
            """, (
                diff_data['zenginData']['bankName'],
                diff_data['zenginData']['bankKana'],
                datetime.utcnow(),
                diff_data['zenginData']['bankCode']
            ))
            
        elif diff_data['diffType'] == 'deletion':
            cursor.execute("""
                DELETE FROM banks WHERE bank_code = %s
            """, (diff_data['zenginData']['bankCode'],))
        
        # トランザクションコミット
        conn.commit()
        
        return {
            'success': True,
            'rowsAffected': cursor.rowcount,
            'executionTime': time.time() - start_time
        }
        
    except Exception as e:
        if conn:
            conn.rollback()  # ロールバック
        raise e
        
    finally:
        if conn:
            connection_pool.putconn(conn)
```

## 📈 アクセスパターン

### 主要アクセスパターン

#### 1. 差分レコードの作成
```python
def create_diff_record(diff_data):
    """
    新しい差分レコードを作成
    """
    response = dynamodb.put_item(
        TableName='zengin-data-diff-dev',
        Item={
            'id': {'S': f"diff-{datetime.now().strftime('%Y%m%d')}-{sequence:03d}"},
            'timestamp': {'S': datetime.utcnow().isoformat()},
            'status': {'S': 'pending'},
            'diffType': {'S': diff_data['type']},
            'zenginData': {'M': convert_to_dynamodb_format(diff_data['zengin'])},
            'currentData': {'M': convert_to_dynamodb_format(diff_data['current'])},
            'ttl': {'N': str(calculate_ttl(90))}
        }
    )
```

#### 2. 状態別レコード検索
```python
def get_pending_diffs(limit=50):
    """
    承認待ち差分レコードを取得
    """
    response = dynamodb.query(
        TableName='zengin-data-diff-dev',
        IndexName='StatusIndex',
        KeyConditionExpression='#status = :status',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={':status': {'S': 'pending'}},
        ScanIndexForward=False,
        Limit=limit
    )
    return response['Items']
```

#### 3. 差分レコードの状態更新
```python
def update_diff_status(diff_id, timestamp, new_status, additional_data=None):
    """
    差分レコードの状態を更新
    """
    update_expression = "SET #status = :status, updatedAt = :updated_at"
    expression_values = {
        ':status': {'S': new_status},
        ':updated_at': {'S': datetime.utcnow().isoformat()}
    }
    
    if additional_data:
        for key, value in additional_data.items():
            update_expression += f", {key} = :{key}"
            expression_values[f":{key}"] = value
    
    response = dynamodb.update_item(
        TableName='zengin-data-diff-dev',
        Key={
            'id': {'S': diff_id},
            'timestamp': {'S': timestamp}
        },
        UpdateExpression=update_expression,
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues=expression_values
    )
```

#### 4. 大容量データの処理
```python
def handle_large_diff_data(diff_data):
    """
    大容量差分データをS3に保存し、参照をDynamoDBに記録
    """
    data_size = len(json.dumps(diff_data).encode())
    
    if data_size > 400 * 1024:  # 400KB以上
        # S3に保存
        s3_key = f"diffs/{diff_data['id']}.json"
        s3_client.put_object(
            Bucket='dev-zengin-diff-data',
            Key=s3_key,
            Body=json.dumps(diff_data),
            ContentType='application/json'
        )
        
        # DynamoDBには参照のみ保存
        return {
            'dataLocation': {'S': f's3://dev-zengin-diff-data/{s3_key}'},
            'dataSize': {'N': str(data_size)},
            'dataSummary': {'M': create_summary(diff_data)}
        }
    else:
        # DynamoDBに直接保存
        return {
            'zenginData': {'M': convert_to_dynamodb_format(diff_data['zengin'])},
            'currentData': {'M': convert_to_dynamodb_format(diff_data['current'])}
        }
```

## ⚡ パフォーマンス最適化

### DynamoDB最適化

#### 読み取りパフォーマンス
```python
# バッチ読み取り（最大100件）
def batch_get_diffs(diff_ids):
    """
    複数の差分レコードを効率的に取得
    """
    request_items = {
        'zengin-data-diff-dev': {
            'Keys': [{'id': {'S': diff_id}} for diff_id in diff_ids]
        }
    }
    
    response = dynamodb.batch_get_item(RequestItems=request_items)
    return response['Responses']['zengin-data-diff-dev']

# 並行クエリ
import asyncio

async def parallel_status_queries():
    """
    複数の状態について並行してクエリ実行
    """
    statuses = ['pending', 'approved', 'executing']
    
    tasks = [
        query_by_status(status) for status in statuses
    ]
    
    results = await asyncio.gather(*tasks)
    return dict(zip(statuses, results))
```

#### 書き込みパフォーマンス
```python
# バッチ書き込み（最大25件）
def batch_write_diffs(diff_records):
    """
    複数の差分レコードを効率的に書き込み
    """
    request_items = {
        'zengin-data-diff-dev': [
            {
                'PutRequest': {
                    'Item': record
                }
            }
            for record in diff_records
        ]
    }
    
    response = dynamodb.batch_write_item(RequestItems=request_items)
    
    # 未処理アイテムの再試行
    while response.get('UnprocessedItems'):
        response = dynamodb.batch_write_item(
            RequestItems=response['UnprocessedItems']
        )
```

### PostgreSQL最適化

#### 接続プール管理
```python
class DatabaseConnectionManager:
    def __init__(self, min_conn=1, max_conn=10):
        self.pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=min_conn,
            maxconn=max_conn,
            **db_config
        )
    
    def execute_query(self, query, params=None):
        conn = None
        try:
            conn = self.pool.getconn()
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                if cursor.description:
                    return cursor.fetchall()
                return cursor.rowcount
        finally:
            if conn:
                self.pool.putconn(conn)
```

#### クエリ最適化
```sql
-- インデックス使用を前提とした効率的なクエリ
SELECT bank_code, bank_name, bank_kana 
FROM banks 
WHERE bank_code = $1;

-- バッチ更新
UPDATE banks 
SET bank_name = data.bank_name,
    bank_kana = data.bank_kana,
    updated_at = CURRENT_TIMESTAMP
FROM (VALUES 
    ('0001', 'みずほ銀行', 'ミズホ'),
    ('0005', '三菱UFJ銀行', 'ミツビシユーエフジェイ')
) AS data(bank_code, bank_name, bank_kana)
WHERE banks.bank_code = data.bank_code;
```

## 🔐 データ保護・セキュリティ

### 暗号化

#### DynamoDB暗号化
```typescript
// CDKでの暗号化設定
const diffTable = new dynamodb.Table(this, 'DiffTable', {
  tableName: 'zengin-data-diff-dev',
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  pointInTimeRecovery: true, // 本番環境のみ
});
```

#### S3暗号化
```typescript
// S3バケットの暗号化設定
const diffDataBucket = new s3.Bucket(this, 'DiffDataBucket', {
  bucketName: 'dev-zengin-diff-data',
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
});
```

### アクセス制御

#### IAM権限設計
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ],
      "Resource": [
        "arn:aws:dynamodb:ap-northeast-1:*:table/zengin-data-diff-*",
        "arn:aws:dynamodb:ap-northeast-1:*:table/zengin-data-diff-*/index/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::*-zengin-diff-data/*"
    }
  ]
}
```

### データ保持ポリシー

#### 保持期間
- **DynamoDB**: TTLによる自動削除（90日）
- **S3**: ライフサイクルポリシーによる削除（90日）
- **PostgreSQL**: 変更履歴は1年間保持

#### バックアップ戦略
```bash
# DynamoDBポイントインタイムリカバリ（本番環境）
aws dynamodb put-backup-policy \
  --table-name zengin-data-diff-prod \
  --backup-policy PointInTimeRecoveryEnabled=true

# PostgreSQLの定期バックアップ
# RDS自動バックアップ設定（7日間保持）
```

このスキーマ設計により、AdvasaBusinessBaseは効率的で安全なデータ管理を実現しています。