import json
import os
import logging
import boto3
import traceback
import hmac
import hashlib
import time
import csv
import io
import tempfile
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional, List
from urllib.parse import parse_qs
from dataclasses import dataclass
import base64
import requests
import gzip

# AWS clients setup
dynamodb = boto3.resource('dynamodb')
secrets_manager = boto3.client('secretsmanager')
scheduler = boto3.client('scheduler')
s3 = boto3.client('s3')
sts = boto3.client('sts')

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.getenv('LOG_LEVEL', 'INFO'))

# Environment variables
DIFF_TABLE_NAME = os.getenv('DIFF_TABLE_NAME')
SCHEDULER_GROUP_NAME = os.getenv('SCHEDULER_GROUP_NAME')
EXECUTE_LAMBDA_ARN = os.getenv('EXECUTE_LAMBDA_ARN')
SLACK_SIGN_SECRET_ARN = os.getenv('SLACK_SIGN_SECRET_ARN')
SLACK_WEBHOOK_SECRET_ARN = os.getenv('SLACK_WEBHOOK_SECRET_ARN')
SCHEDULER_ROLE_ARN = os.getenv('SCHEDULER_ROLE_ARN')
ENVIRONMENT = os.getenv('ENVIRONMENT', 'dev')
S3_BUCKET_NAME = os.getenv('S3_BUCKET_NAME', f'{ENVIRONMENT}-zengin-diff-data')

# JST timezone
JST = timezone(timedelta(hours=9))

def now_jst():
    """Get current time in JST"""
    return datetime.now(JST)

def get_account_id():
    """Get current AWS account ID"""
    try:
        response = sts.get_caller_identity()
        return response['Account']
    except Exception as e:
        logger.error(f"Failed to get account ID: {str(e)}")
        # Fallback to environment variable if available
        return os.getenv('AWS_ACCOUNT_ID', '')

def load_diffs_from_s3(s3_key: str) -> List[Dict[str, Any]]:
    """S3から差分データを読み込み"""
    try:
        logger.info(f"S3から差分データを読み込み: s3://{S3_BUCKET_NAME}/{s3_key}")
        
        # S3からgzip圧縮されたデータを取得
        response = s3.get_object(Bucket=S3_BUCKET_NAME, Key=s3_key)
        compressed_data = response['Body'].read()
        
        # gzipを解凍
        json_data = gzip.decompress(compressed_data).decode('utf-8')
        
        # JSONをパース
        diffs_data = json.loads(json_data)
        
        logger.info(f"S3から{len(diffs_data)}件の差分データを読み込みました")
        return diffs_data
        
    except Exception as e:
        logger.error(f"S3からの差分データ読み込みエラー: {str(e)}")
        raise

@dataclass
class BankData:
    """銀行データモデル"""
    swift_code: str
    bank_name: str
    bank_name_kana: str
    branch_code: str
    branch_name: str
    branch_name_kana: str

@dataclass
class BankDiff:
    """差分データモデル"""
    action: str  # "create", "update", "delete"
    key: str  # swift_code-branch_code
    old_data: Optional[BankData] = None
    new_data: Optional[BankData] = None
    total_accounts: int = 0
    active_users: int = 0

@dataclass
class BankUpdateRequestData:
    """更新リクエストデータ"""
    diffs: List[BankDiff]
    summary: str
    total_changes: int
    created_at: str

class SlackSignatureValidator:
    """Slack署名検証"""
    
    def __init__(self):
        self.signing_secret = None
    
    def _get_signing_secret(self) -> str:
        """Slack署名秘密鍵を取得"""
        if self.signing_secret:
            return self.signing_secret
            
        try:
            response = secrets_manager.get_secret_value(SecretId=SLACK_SIGN_SECRET_ARN)
            secret_data = json.loads(response['SecretString'])
            self.signing_secret = secret_data['signingSecret']
            return self.signing_secret
        except Exception as e:
            logger.error(f"Slack署名秘密鍵取得エラー: {str(e)}")
            raise
    
    def validate_signature(self, headers: Dict[str, str], body: str) -> bool:
        """Slack署名を検証"""
        try:
            # 必要なヘッダーを取得
            slack_signature = headers.get('x-slack-signature', '')
            slack_timestamp = headers.get('x-slack-request-timestamp', '')
            
            if not slack_signature or not slack_timestamp:
                logger.error("Slack署名またはタイムスタンプが見つかりません")
                return False
            
            # タイムスタンプチェック（5分以内）
            current_time = int(time.time())
            if abs(current_time - int(slack_timestamp)) > 300:
                logger.error("リクエストタイムスタンプが古すぎます")
                return False
            
            # 署名文字列を作成
            signing_secret = self._get_signing_secret()
            sig_basestring = f"v0:{slack_timestamp}:{body}"
            
            # HMAC-SHA256で署名を計算
            expected_signature = 'v0=' + hmac.new(
                signing_secret.encode(),
                sig_basestring.encode(),
                hashlib.sha256
            ).hexdigest()
            
            # 署名を比較
            if hmac.compare_digest(slack_signature, expected_signature):
                return True
            else:
                logger.error("Slack署名が一致しません")
                return False
                
        except Exception as e:
            logger.error(f"Slack署名検証エラー: {str(e)}")
            return False

# ----- Slack Migration: Use bot token client instead of webhook -----
from common.slack_client import SlackClient

class CSVExporter:
    """CSV出力クラス"""
    
    def __init__(self):
        self.s3_bucket = f"advasa-business-base-{ENVIRONMENT}-csv-exports"
    
    def create_csv_from_diffs(self, update_request: BankUpdateRequestData) -> str:
        """差分データからCSVファイルを作成し、S3にアップロード"""
        try:
            # CSVデータを生成
            csv_content = self._generate_csv_content(update_request)
            
            # ファイル名を生成
            filename = f"zengin_diff_{now_jst().strftime('%Y%m%d_%H%M%S')}.csv"
            s3_key = f"csv-exports/{filename}"
            
            # S3にアップロード
            s3.put_object(
                Bucket=self.s3_bucket,
                Key=s3_key,
                Body=csv_content.encode('utf-8-sig'),  # BOMを付けてExcelで文字化けを防ぐ
                ContentType='text/csv',
                ContentDisposition=f'attachment; filename="{filename}"'
            )
            
            # Pre-signed URLを生成（7日間有効）
            presigned_url = s3.generate_presigned_url(
                'get_object',
                Params={'Bucket': self.s3_bucket, 'Key': s3_key},
                ExpiresIn=7*24*60*60  # 7日間
            )
            
            logger.info(f"CSV ファイル作成完了: {s3_key}")
            return presigned_url, filename
            
        except Exception as e:
            logger.error(f"CSV作成エラー: {str(e)}")
            raise
    
    def _generate_csv_content(self, update_request: BankUpdateRequestData) -> str:
        """CSVコンテンツを生成"""
        output = io.StringIO()
        csv_writer = csv.writer(output)
        
        # ヘッダー行を書き込み
        headers = [
            "アクション", "銀行コード", "支店コード", 
            "旧銀行名", "新銀行名", "旧銀行カナ", "新銀行カナ",
            "旧支店名", "新支店名", "旧支店カナ", "新支店カナ",
            "変更フィールド", "変更理由", "影響アカウント数", "稼働ユーザー数"
        ]
        csv_writer.writerow(headers)
        
        # 各差分をCSV行として出力 (影響アカウント数 → 稼働ユーザー数 の多い順 → 銀行コード順)
        sorted_diffs = sorted(update_request.diffs, 
                            key=lambda d: (-d.total_accounts, -d.active_users, d.key))
        
        for diff in sorted_diffs:
            swift_code, branch_code = diff.key.split("-")
            
            # 変更フィールドを特定
            changed_fields = []
            if diff.action == "update" and diff.old_data and diff.new_data:
                fields_to_check = [
                    ("bank_name", "銀行名"),
                    ("bank_name_kana", "銀行カナ"), 
                    ("branch_name", "支店名"),
                    ("branch_name_kana", "支店カナ")
                ]
                for field, field_name in fields_to_check:
                    old_val = getattr(diff.old_data, field, "") if diff.old_data else ""
                    new_val = getattr(diff.new_data, field, "") if diff.new_data else ""
                    if str(old_val).strip() != str(new_val).strip():
                        changed_fields.append(field_name)
            
            # アクション種別に応じて行を作成
            if diff.action == "create":
                row = [
                    "新規追加", swift_code, branch_code,
                    "", diff.new_data.bank_name if diff.new_data else "",
                    "", diff.new_data.bank_name_kana if diff.new_data else "",
                    "", diff.new_data.branch_name if diff.new_data else "",
                    "", diff.new_data.branch_name_kana if diff.new_data else "",
                    "全項目", "zengin-codeライブラリに新規追加",
                    diff.total_accounts, diff.active_users
                ]
            elif diff.action == "update":
                row = [
                    "更新", swift_code, branch_code,
                    diff.old_data.bank_name if diff.old_data else "",
                    diff.new_data.bank_name if diff.new_data else "",
                    diff.old_data.bank_name_kana if diff.old_data else "",
                    diff.new_data.bank_name_kana if diff.new_data else "",
                    diff.old_data.branch_name if diff.old_data else "",
                    diff.new_data.branch_name if diff.new_data else "",
                    diff.old_data.branch_name_kana if diff.old_data else "",
                    diff.new_data.branch_name_kana if diff.new_data else "",
                    "、".join(changed_fields) if changed_fields else "",
                    "zengin-codeライブラリで情報更新",
                    diff.total_accounts, diff.active_users
                ]
            elif diff.action == "delete":
                impact_note = f" ⚠️影響：{diff.total_accounts}アカウント" if diff.total_accounts > 0 else ""
                row = [
                    "削除", swift_code, branch_code,
                    diff.old_data.bank_name if diff.old_data else "", "",
                    diff.old_data.bank_name_kana if diff.old_data else "", "",
                    diff.old_data.branch_name if diff.old_data else "", "",
                    diff.old_data.branch_name_kana if diff.old_data else "", "",
                    "", f"zengin-codeライブラリから削除{impact_note}",
                    diff.total_accounts, diff.active_users
                ]
            
            # 文字列セルの前後空白・改行を除去
            clean_row = [v.strip() if isinstance(v, str) else v for v in row]
            csv_writer.writerow(clean_row)
        
        return output.getvalue()

class SlackInteractionHandler:
    """Slackインタラクション処理"""
    
    def __init__(self):
        self.table = dynamodb.Table(DIFF_TABLE_NAME)
        self.slack_client = SlackClient()
        self.csv_exporter = CSVExporter()
    
    def parse_payload(self, body: str) -> Dict[str, Any]:
        """Slackペイロードを解析"""
        try:
            # URL-encoded形式をパース
            parsed = parse_qs(body)
            payload_str = parsed.get('payload', [''])[0]
            
            if not payload_str:
                raise ValueError("ペイロードが見つかりません")
            
            payload = json.loads(payload_str)
            return payload
            
        except Exception as e:
            logger.error(f"ペイロード解析エラー: {str(e)}")
            raise
    
    def handle_interaction(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """インタラクション処理のメインロジック"""
        try:
            interaction_type = payload.get('type')
            
            if interaction_type == 'block_actions':
                return self._handle_block_actions(payload)
            elif interaction_type == 'interactive_message':
                return self._handle_interactive_message(payload)
            else:
                logger.warning(f"未対応のインタラクションタイプ: {interaction_type}")
                return self._create_response("未対応のインタラクションです")
                
        except Exception as e:
            logger.error(f"インタラクション処理エラー: {str(e)}")
            raise
    
    def _handle_block_actions(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """ブロックアクション処理"""
        try:
            actions = payload.get('actions', [])
            if not actions:
                return self._create_response("アクションが見つかりません")
            
            action = actions[0]
            action_id = action.get('action_id')
            action_value = action.get('value')
            user = payload.get('user', {})
            user_name = user.get('name', 'Unknown')
            
            # メッセージタイムスタンプを取得
            message = payload.get('message', {})
            message_ts = message.get('ts')
            
            if not message_ts:
                return self._create_response("メッセージタイムスタンプが見つかりません")
            
            # アクション値をパース
            try:
                action_data = json.loads(action_value) if action_value else {}
            except json.JSONDecodeError:
                action_data = {}
            
            logger.info(f"アクション処理: {action_id} by {user_name}")
            
            # アクションに応じて処理
            if action_id == 'approve_update':
                return self._handle_approval(message_ts, user_name, "scheduled", "23:00")
            elif action_id == 'approve_immediate':
                return self._handle_approval(message_ts, user_name, "immediate", "immediate")
            elif action_id == 'approve_1h':
                return self._handle_approval(message_ts, user_name, "custom", "1h")
            elif action_id == 'approve_3h':
                return self._handle_approval(message_ts, user_name, "custom", "3h")
            elif action_id == 'approve_5h':
                return self._handle_approval(message_ts, user_name, "custom", "5h")
            elif action_id == 'reject_update':
                return self._handle_rejection(message_ts, user_name)
            elif action_id == 'export_csv':
                return self._handle_csv_export(message_ts, user_name)
            else:
                logger.warning(f"未対応のアクション: {action_id}")
                return self._create_response("未対応のアクションです")
                
        except Exception as e:
            logger.error(f"ブロックアクション処理エラー: {str(e)}")
            raise
    
    def _handle_interactive_message(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """インタラクティブメッセージ処理"""
        # 互換性のため残しているが、主にblock_actionsを使用
        return self._create_response("このメッセージ形式は非推奨です")
    
    def _handle_approval(self, message_ts: str, user_name: str, execution_type: str, execution_time: str) -> Dict[str, Any]:
        """承認処理"""
        try:
            # DynamoDBで差分データを検索
            diff_item = self._find_diff_by_timestamp(message_ts)
            if not diff_item:
                return self._create_response("対応する差分データが見つかりません")
            
            # 既に処理済みかチェック
            if diff_item.get('status') != 'pending':
                self.slack_client.send_duplicate_action_warning(
                    message_ts, user_name, "通常承認"
                )
                return self._create_response(f"この差分は既に処理済みです (ステータス: {diff_item.get('status')})")
            
            # 承認処理
            if execution_type == "immediate":
                # 即時実行
                self._execute_immediate(diff_item, user_name)
                self.slack_client.update_message_with_result(
                    message_ts, True, user_name, "即時実行", "immediate"
                )
                return self._create_response(f"✅ 即時実行を開始しました (承認者: {user_name})")
            else:
                # スケジュール実行
                schedule_time = self._calculate_schedule_time(execution_type, execution_time)
                self._schedule_execution(diff_item, user_name, schedule_time, execution_type)
                self.slack_client.update_message_with_result(
                    message_ts, True, user_name, schedule_time.strftime('%Y-%m-%d %H:%M:%S'), execution_type
                )
                return self._create_response(f"✅ 承認されました (承認者: {user_name}, 実行予定: {schedule_time.strftime('%Y-%m-%d %H:%M:%S')} JST)")
                
        except Exception as e:
            logger.error(f"承認処理エラー: {str(e)}")
            self.slack_client.send_error_notification(
                "承認処理エラー",
                str(e),
                {"user": user_name, "action": "承認", "timestamp": now_jst().isoformat()},
                message_ts
            )
            raise
    
    def _handle_rejection(self, message_ts: str, user_name: str) -> Dict[str, Any]:
        """却下処理"""
        try:
            # DynamoDBで差分データを検索
            diff_item = self._find_diff_by_timestamp(message_ts)
            if not diff_item:
                return self._create_response("対応する差分データが見つかりません")
            
            # 既に処理済みかチェック
            if diff_item.get('status') != 'pending':
                self.slack_client.send_duplicate_action_warning(
                    message_ts, user_name, "却下"
                )
                return self._create_response(f"この差分は既に処理済みです (ステータス: {diff_item.get('status')})")
            
            # 却下処理
            self.table.update_item(
                Key={
                    'id': diff_item['id'],
                    'timestamp': diff_item['timestamp']  # Sort Keyも必要
                },
                UpdateExpression='SET #status = :status, rejected_by = :user, rejected_at = :timestamp',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={
                    ':status': 'rejected',
                    ':user': user_name,
                    ':timestamp': datetime.now(timezone.utc).isoformat()
                }
            )
            
            self.slack_client.update_message_with_result(message_ts, False, user_name)
            
            logger.info(f"差分が却下されました: {diff_item['id']} by {user_name}")
            return self._create_response(f"❌ 差分更新が却下されました (却下者: {user_name})")
            
        except Exception as e:
            logger.error(f"却下処理エラー: {str(e)}")
            self.slack_client.send_error_notification(
                "却下処理エラー",
                str(e),
                {"user": user_name, "action": "却下", "timestamp": now_jst().isoformat()},
                message_ts
            )
            raise
    
    def _handle_csv_export(self, message_ts: str, user_name: str) -> Dict[str, Any]:
        """CSV出力処理"""
        try:
            logger.info(f"CSV出力要求: {user_name} for message {message_ts}")
            
            # DynamoDBで差分データを検索
            diff_item = self._find_diff_by_timestamp(message_ts)
            if not diff_item:
                return self._create_response("対応する差分データが見つかりません")
            
            # S3から完全な差分データを読み込み
            if not diff_item.get('diffs_s3_key'):
                return self._create_response("差分データのS3参照が見つかりません")
            
            diffs_data = load_diffs_from_s3(diff_item['diffs_s3_key'])
            
            # BankUpdateRequestDataオブジェクトを復元
            diffs = []
            for diff_dict in diffs_data:
                old_data = None
                new_data = None
                
                if diff_dict.get('old_data'):
                    old_data = BankData(**diff_dict['old_data'])
                if diff_dict.get('new_data'):
                    new_data = BankData(**diff_dict['new_data'])
                
                diffs.append(BankDiff(
                    action=diff_dict['action'],
                    key=diff_dict['key'],
                    old_data=old_data,
                    new_data=new_data,
                    total_accounts=diff_dict.get('total_accounts', 0),
                    active_users=diff_dict.get('active_users', 0)
                ))
            
            update_request = BankUpdateRequestData(
                diffs=diffs,
                summary=diff_item.get('summary', 'N/A'),
                total_changes=diff_item.get('total_changes', len(diffs)),
                created_at=diff_item.get('timestamp', datetime.now(timezone.utc).isoformat())
            )
            
            # CSVファイルを作成してSlackに送信
            self.slack_client.send_csv_diff(update_request, message_ts)
            
            logger.info(f"CSV出力完了: {len(diffs)}件の差分")
            return self._create_response("📄 CSV出力を開始しています...")
            
        except Exception as e:
            logger.error(f"CSV出力エラー: {str(e)}")
            self.slack_client.send_error_notification(
                "CSV出力エラー",
                str(e),
                {"user": user_name, "action": "CSV出力", "timestamp": now_jst().isoformat()},
                message_ts
            )
            return self._create_response("❌ CSV出力でエラーが発生しました")
    
    def _find_diff_by_timestamp(self, message_ts: str) -> Optional[Dict[str, Any]]:
        """メッセージタイムスタンプで差分データを検索"""
        try:
            # タイムスタンプを直接使用してslack_tsで検索
            response = self.table.scan(
                FilterExpression='slack_ts = :ts',
                ExpressionAttributeValues={':ts': message_ts}
            )
            
            items = response.get('Items', [])
            if items:
                return items[0]  # 最初にマッチしたアイテムを返す
            
            # フォールバック: タイムスタンプベースの検索
            try:
                timestamp_float = float(message_ts)
                message_time = datetime.fromtimestamp(timestamp_float, tz=timezone.utc)
                
                # 前後5分の範囲でスキャン
                start_time = (message_time - timedelta(minutes=5)).isoformat()
                end_time = (message_time + timedelta(minutes=5)).isoformat()
                
                response = self.table.scan(
                    FilterExpression='#timestamp BETWEEN :start_time AND :end_time AND #status = :status',
                    ExpressionAttributeNames={
                        '#timestamp': 'timestamp',
                        '#status': 'status'
                    },
                    ExpressionAttributeValues={
                        ':start_time': start_time,
                        ':end_time': end_time,
                        ':status': 'pending'
                    }
                )
                
                items = response.get('Items', [])
                if items:
                    # 最も近いタイムスタンプのアイテムを返す
                    return min(items, key=lambda x: abs(
                        datetime.fromisoformat(x['timestamp'].replace('Z', '+00:00')).timestamp() - timestamp_float
                    ))
            except (ValueError, TypeError):
                pass
            
            return None
            
        except Exception as e:
            logger.error(f"差分データ検索エラー: {str(e)}")
            return None
    
    def _calculate_schedule_time(self, execution_type: str, execution_time: str) -> datetime:
        """実行スケジュール時刻を計算"""
        now_jst_time = now_jst()
        
        if execution_type == "scheduled" and execution_time == "23:00":
            # 23時実行
            target = now_jst_time.replace(hour=23, minute=0, second=0, microsecond=0)
            if target <= now_jst_time:
                # 今日の23時を過ぎている場合は明日の23時
                target += timedelta(days=1)
            return target
        elif execution_type == "custom":
            # カスタム時間
            if execution_time == "1h":
                return now_jst_time + timedelta(hours=1)
            elif execution_time == "3h":
                return now_jst_time + timedelta(hours=3)
            elif execution_time == "5h":
                return now_jst_time + timedelta(hours=5)
        
        # デフォルトは1時間後
        return now_jst_time + timedelta(hours=1)
    
    def _schedule_execution(self, diff_item: Dict[str, Any], user_name: str, schedule_time: datetime, execution_type: str):
        """EventBridge Schedulerでスケジュール実行を設定"""
        try:
            diff_id = diff_item['id']
            
            # スケジュール名
            schedule_name = f"zengin-diff-execution-{diff_id}"
            
            # UTCに変換
            schedule_time_utc = schedule_time.astimezone(timezone.utc)
            
            # スケジュール式 (at expression)
            schedule_expression = f"at({schedule_time_utc.strftime('%Y-%m-%dT%H:%M:%S')})"
            
            # Lambda実行用のペイロード
            target_payload = {
                "diff_id": diff_id,
                "scheduled_execution": True,
                "approved_by": user_name,
                "execution_type": execution_type
            }
            
            # EventBridge Schedulerにスケジュールを作成
            if not SCHEDULER_ROLE_ARN:
                # Fallback: construct role ARN from account ID
                account_id = get_account_id()
                scheduler_role_arn = f"arn:aws:iam::{account_id}:role/{ENVIRONMENT}-AdvasaBusinessBase-EventBridge-SchedulerRole"
                logger.warning(f"SCHEDULER_ROLE_ARN not set, using fallback: {scheduler_role_arn}")
            else:
                scheduler_role_arn = SCHEDULER_ROLE_ARN
                logger.info(f"Using configured scheduler role ARN: {scheduler_role_arn}")
            
            scheduler.create_schedule(
                GroupName=SCHEDULER_GROUP_NAME,
                Name=schedule_name,
                ScheduleExpression=schedule_expression,
                Target={
                    'Arn': EXECUTE_LAMBDA_ARN,
                    'RoleArn': scheduler_role_arn,
                    'Input': json.dumps(target_payload)
                },
                FlexibleTimeWindow={
                    'Mode': 'OFF'
                },
                ActionAfterCompletion='DELETE',
                Description=f"Zengin data diff execution for {diff_id}"
            )
            
            # DynamoDBの状態を更新
            self.table.update_item(
                Key={
                    'id': diff_id,
                    'timestamp': diff_item['timestamp']  # Sort Keyも必要
                },
                UpdateExpression='SET #status = :status, approved_by = :user, approved_at = :timestamp, scheduled_at = :schedule_time, execution_type = :exec_type',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={
                    ':status': 'scheduled',
                    ':user': user_name,
                    ':timestamp': datetime.now(timezone.utc).isoformat(),
                    ':schedule_time': schedule_time_utc.isoformat(),
                    ':exec_type': execution_type
                }
            )
            
            logger.info(f"スケジュール実行を設定: {schedule_name} at {schedule_time_utc}")
            
        except Exception as e:
            logger.error(f"スケジュール設定エラー: {str(e)}")
            raise
    
    def _execute_immediate(self, diff_item: Dict[str, Any], user_name: str):
        """即時実行（Lambda同期呼び出し）"""
        try:
            diff_id = diff_item['id']
            
            # VPCエンドポイント経由でLambda呼び出し（privateDnsEnabled: trueで自動解決）
            lambda_client = boto3.client('lambda')
            
            payload = {
                "diff_id": diff_id,
                "immediate_execution": True,
                "approved_by": user_name,
                "execution_type": "immediate"
            }
            
            # Lambda関数を非同期で呼び出し
            lambda_client.invoke(
                FunctionName=EXECUTE_LAMBDA_ARN,
                InvocationType='Event',  # 非同期呼び出し
                Payload=json.dumps(payload)
            )
            
            # DynamoDBの状態を更新
            self.table.update_item(
                Key={
                    'id': diff_id,
                    'timestamp': diff_item['timestamp']  # Sort Keyも必要
                },
                UpdateExpression='SET #status = :status, approved_by = :user, approved_at = :timestamp, execution_type = :exec_type',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={
                    ':status': 'approved',
                    ':user': user_name,
                    ':timestamp': datetime.now(timezone.utc).isoformat(),
                    ':exec_type': 'immediate'
                }
            )
            
            logger.info(f"即時実行を開始: {diff_id}")
            
        except Exception as e:
            logger.error(f"即時実行エラー: {str(e)}")
            raise
    
    def _create_response(self, message: str) -> Dict[str, Any]:
        """Slack応答メッセージを作成"""
        return {
            "response_type": "ephemeral",
            "text": message,
            "replace_original": False
        }

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Lambda関数のメインハンドラー"""
    try:
        logger.info(f"Slackコールバック処理を開始: {json.dumps(event, ensure_ascii=False)}")
        
        # Check if this is a direct Lambda invocation from slack-interactive
        if 'interaction_type' in event and 'payload' in event:
            return handle_direct_invocation(event)
        
        # Original API Gateway handling
        # HTTPヘッダーとボディを取得
        headers = event.get('headers', {})
        body = event.get('body', '')
        
        # Base64デコードが必要な場合
        if event.get('isBase64Encoded', False):
            body = base64.b64decode(body).decode('utf-8')
        
        # Slack署名検証
        validator = SlackSignatureValidator()
        if not validator.validate_signature(headers, body):
            logger.error("Slack署名検証失敗")
            return {
                'statusCode': 401,
                'body': json.dumps({'error': 'Unauthorized'})
            }
        
        # インタラクション処理
        handler_instance = SlackInteractionHandler()
        payload = handler_instance.parse_payload(body)
        response = handler_instance.handle_interaction(payload)
        
        logger.info("Slackコールバック処理完了")
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json'
            },
            'body': json.dumps(response, ensure_ascii=False)
        }
        
    except Exception as e:
        error_message = f"Slackコールバック処理エラー: {str(e)}"
        logger.error(f"{error_message}\n{traceback.format_exc()}")
        
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': error_message,
                'traceback': traceback.format_exc()
            }, ensure_ascii=False)
        }

def handle_direct_invocation(event: Dict[str, Any]) -> Dict[str, Any]:
    """Handle direct Lambda invocation from slack-interactive function"""
    try:
        # slack-interactiveからのペイロードを解析
        payload = event.get('payload', {})
        user = payload.get('user', {})
        user_name = user.get('name', 'Unknown')
        message = payload.get('message', {})
        message_ts = message.get('ts')
        
        # アクション情報を取得
        actions = payload.get('actions', [])
        if not actions:
            logger.error("アクションが見つかりません")
            return {"status": "error", "message": "No actions found"}
        
        action = actions[0]
        action_id = action.get('action_id')
        
        logger.info(f"Processing direct invocation: {action_id} by {user_name} for message {message_ts}")
        
        handler_instance = SlackInteractionHandler()
        
        if action_id == 'approve_update':
            return handler_instance._handle_approval(message_ts, user_name, "scheduled", "23:00")
        
        elif action_id == 'approve_immediate':
            return handler_instance._handle_approval(message_ts, user_name, "immediate", "immediate")
        
        elif action_id == 'approve_1h':
            return handler_instance._handle_approval(message_ts, user_name, "custom", "1h")
        
        elif action_id == 'approve_3h':
            return handler_instance._handle_approval(message_ts, user_name, "custom", "3h")
        
        elif action_id == 'approve_5h':
            return handler_instance._handle_approval(message_ts, user_name, "custom", "5h")
        
        elif action_id == 'reject_update':
            return handler_instance._handle_rejection(message_ts, user_name)
        
        elif action_id == 'export_csv':
            return handler_instance._handle_csv_export(message_ts, user_name)
        
        else:
            logger.warning(f"Unhandled direct invocation action: {action_id}")
            return {"status": "error", "message": f"Unhandled action: {action_id}"}
            
    except Exception as e:
        logger.error(f"Direct invocation error: {str(e)}")
        traceback.print_exc()
        return {"status": "error", "message": str(e)}