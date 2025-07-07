import json
import os
import logging
import boto3
import boto3.dynamodb.conditions
import traceback
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from common.slack_client import SlackClient
import gzip
from urllib.parse import quote_plus

# AWS clients setup
dynamodb = boto3.resource('dynamodb')
secrets_manager = boto3.client('secretsmanager')
s3 = boto3.client('s3')

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.getenv('LOG_LEVEL', 'INFO'))

# Environment variables
DIFF_TABLE_NAME = os.getenv('DIFF_TABLE_NAME')
DATABASE_SECRET_ARN = os.getenv('DATABASE_SECRET_ARN')
SLACK_WEBHOOK_SECRET_ARN = os.getenv('SLACK_WEBHOOK_SECRET_ARN')
ENVIRONMENT = os.getenv('ENVIRONMENT', 'dev')
S3_BUCKET_NAME = os.getenv('S3_BUCKET_NAME', f'{ENVIRONMENT}-zengin-diff-data')

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
class ExecutionResult:
    """実行結果"""
    success: bool
    processed_count: int
    error_count: int
    errors: List[str]
    details: str

class DatabaseClient:
    """データベースクライアント"""
    
    def __init__(self):
        self.connection = None
        self.db_credentials = None
    
    def _get_db_credentials(self) -> Dict[str, str]:
        """データベース認証情報を取得"""
        if self.db_credentials:
            return self.db_credentials
            
        try:
            response = secrets_manager.get_secret_value(SecretId=DATABASE_SECRET_ARN)
            self.db_credentials = json.loads(response['SecretString'])
            return self.db_credentials
        except Exception as e:
            logger.error(f"データベース認証情報取得エラー: {str(e)}")
            raise
    
    def connect(self):
        """データベースに接続"""
        try:
            if self.connection and not self.connection.closed:
                return self.connection
                
            credentials = self._get_db_credentials()
            
            self.connection = psycopg2.connect(
                host=credentials['host'],
                port=credentials.get('port', 5432),
                database=credentials['database'],
                user=credentials['username'],
                password=credentials['password'],
                connect_timeout=30,
                sslmode="require"
            )
            
            # オートコミットを無効にして手動トランザクション管理
            self.connection.autocommit = False
            
            logger.info("データベース接続成功")
            return self.connection
            
        except Exception as e:
            logger.error(f"データベース接続エラー: {str(e)}")
            raise
    
    def close(self):
        """データベース接続を閉じる"""
        if self.connection and not self.connection.closed:
            try:
                self.connection.close()
                logger.info("データベース接続を閉じました")
            except Exception as e:
                logger.warning(f"データベース接続クローズエラー: {str(e)}")
    
    def execute_diff(self, diff: BankDiff) -> bool:
        """単一の差分を実行"""
        try:
            conn = self.connect()
            cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            
            swift_code, branch_code = diff.key.split("-")
            
            if diff.action == "create":
                # 新規追加
                sql = """
                INSERT INTO m_bank (
                    swift_code, bank_name, bank_name_kana,
                    branch_code, branch_name, branch_name_kana,
                    created_at, updated_at, is_deleted
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, NOW(), NOW(), 0
                )
                """
                params = (
                    diff.new_data.swift_code,
                    diff.new_data.bank_name,
                    diff.new_data.bank_name_kana,
                    diff.new_data.branch_code,
                    diff.new_data.branch_name,
                    diff.new_data.branch_name_kana
                )
                cursor.execute(sql, params)
                logger.info(f"MBank新規追加: {diff.key}")
                
            elif diff.action == "update":
                # 更新
                sql = """
                UPDATE m_bank SET
                    bank_name = %s,
                    bank_name_kana = %s,
                    branch_name = %s,
                    branch_name_kana = %s,
                    updated_at = NOW(),
                    updated_user = 'zengin-updater'
                WHERE swift_code = %s AND branch_code = %s AND is_deleted = 0
                """
                params = (
                    diff.new_data.bank_name,
                    diff.new_data.bank_name_kana,
                    diff.new_data.branch_name,
                    diff.new_data.branch_name_kana,
                    swift_code,
                    branch_code
                )
                cursor.execute(sql, params)
                
                # 影響を受けた行数をチェック
                if cursor.rowcount == 0:
                    logger.warning(f"更新対象が見つかりません: {diff.key}")
                else:
                    logger.info(f"MBank更新: {diff.key} ({cursor.rowcount}件)")
                
                # 関連するUserBankAccountも更新
                self._update_user_bank_accounts(cursor, swift_code, branch_code, diff.new_data)
                
            elif diff.action == "delete":
                # 論理削除
                sql = """
                UPDATE m_bank SET
                    is_deleted = 1,
                    updated_at = NOW()
                WHERE swift_code = %s AND branch_code = %s AND is_deleted = 0
                """
                params = (swift_code, branch_code)
                cursor.execute(sql, params)
                
                if cursor.rowcount == 0:
                    logger.warning(f"削除対象が見つかりません: {diff.key}")
                else:
                    logger.info(f"MBank削除（論理削除）: {diff.key} ({cursor.rowcount}件)")
                
                # UserBankAccountへの影響を警告ログ
                affected_accounts = self._get_affected_user_accounts(cursor, swift_code, branch_code)
                if affected_accounts:
                    logger.warning(f"削除により影響を受けるUserBankAccount: {len(affected_accounts)}件")
            
            cursor.close()
            return True
            
        except Exception as e:
            logger.error(f"差分実行エラー {diff.key}: {str(e)}")
            raise
    
    def _update_user_bank_accounts(self, cursor, swift_code: str, branch_code: str, new_data: BankData):
        """関連するUserBankAccountを更新"""
        try:
            # UserBankAccountテーブルが存在するかチェック
            cursor.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'user_bank_account' 
                    AND table_schema = current_schema()
                )
            """)
            
            # RealDictCursorを使用している場合は辞書、通常はタプルが返るため両方に対応
            row = cursor.fetchone()
            exists_flag = list(row.values())[0] if isinstance(row, dict) else row[0]
            if not exists_flag:
                logger.info("UserBankAccountテーブルが存在しません。スキップします。")
                return
            
            # 関連するUserBankAccountを更新
            sql = """
            UPDATE user_bank_account SET
                bank_name = %s,
                branch_name = %s,
                updated_at = NOW(),
                updated_user = 'zengin-updater'
            WHERE bank_swift_code = %s AND branch_code = %s AND is_deleted = 0
            """
            params = (
                new_data.bank_name,
                new_data.branch_name,
                swift_code,
                branch_code
            )
            
            cursor.execute(sql, params)

            if cursor.rowcount == 0:
                logger.info(f"UserBankAccount更新対象が見つかりませんでした。swift_code={swift_code}, branch_code={branch_code}")
                return
            
            if cursor.rowcount > 0:
                logger.info(f"UserBankAccount更新: {cursor.rowcount}件")
            
        except Exception as e:
            logger.error(f"UserBankAccount更新エラー: {str(e)}")
            logger.error(f"エラーの詳細: {traceback.format_exc()}")
            # デバッグ用にSQLとパラメータも出力
            logger.error(f"実行SQL: {sql}")
            logger.error(f"パラメータ: {params}")
            # UserBankAccountの更新エラーは致命的ではないため、ログのみ
    
    def _get_affected_user_accounts(self, cursor, swift_code: str, branch_code: str) -> List[Dict]:
        """影響を受けるUserBankAccountを取得"""
        try:
            # UserBankAccountテーブルが存在するかチェック
            cursor.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'user_bank_account' 
                    AND table_schema = current_schema()
                )
            """)
            
            # RealDictCursorを使用している場合は辞書、通常はタプルが返るため両方に対応
            row = cursor.fetchone()
            exists_flag = list(row.values())[0] if isinstance(row, dict) else row[0]
            if not exists_flag:
                return []
            
            sql = """
            SELECT id, user_id, bank_swift_code, branch_code, bank_name, branch_name
            FROM user_bank_account
            WHERE bank_swift_code = %s AND branch_code = %s AND is_deleted = 0
            """
            
            cursor.execute(sql, (swift_code, branch_code))
            return cursor.fetchall()
            
        except Exception as e:
            logger.error(f"影響UserBankAccount取得エラー: {str(e)}")
            return []


class BankUpdater:
    """銀行データ更新メインクラス"""
    
    def __init__(self):
        self.db_client = DatabaseClient()
        self.slack_client = SlackClient()
        self.table = dynamodb.Table(DIFF_TABLE_NAME)
    
    def execute_update(self, diff_id: str, approved_by: str = None) -> ExecutionResult:
        """差分更新メイン処理"""
        try:
            logger.info(f"銀行データ更新を開始: {diff_id}")
            
            # DynamoDBから差分データを取得
            diff_data = self._get_diff_data(diff_id)
            if not diff_data:
                raise ValueError(f"差分データが見つかりません: {diff_id}")
            
            # 差分リストを復元（常にS3から読み込み）
            if not diff_data.get('diffs_s3_key'):
                raise ValueError(f"S3キーが見つかりません: {diff_id}")
            
            # S3から完全なデータを読み込み
            diffs_data = self._load_diffs_from_s3(diff_data['diffs_s3_key'])
            diffs = self._restore_diffs(diffs_data)
            
            # トランザクション開始
            conn = self.db_client.connect()
            
            success_count = 0
            error_count = 0
            errors = []
            
            try:
                # 各差分を処理
                for diff in diffs:
                    try:
                        self.db_client.execute_diff(diff)
                        success_count += 1
                    except Exception as e:
                        error_count += 1
                        error_msg = f"{diff.key}: {str(e)}"
                        errors.append(error_msg)
                        logger.error(f"差分処理エラー: {error_msg}")
                        
                        # エラー数が一定数を超えた場合は早期終了
                        if error_count >= 100:
                            logger.error(f"エラー数が閾値(100)を超えました。処理を中断します。")
                            break
                
                # 結果に基づいてコミットまたはロールバック
                # エラー率が50%を超える場合はロールバック
                error_rate = error_count / len(diffs) if len(diffs) > 0 else 0
                overall_success = error_count == 0 or (error_count <= 10 and error_rate < 0.1)
                
                if overall_success:
                    conn.commit()
                    if error_count == 0:
                        logger.info("全ての差分処理が成功しました。トランザクションをコミットします。")
                    else:
                        logger.info(f"軽微なエラー({error_count}件)がありましたが、処理を続行します。トランザクションをコミットします。")
                else:
                    conn.rollback()
                    logger.error(f"エラーが多数発生しました（{error_count}件、エラー率: {error_rate:.1%}）。トランザクションをロールバックします。")
                
                # 実行結果を作成
                details = f"成功: {success_count}件"
                if error_count > 0:
                    details += f", エラー: {error_count}件"
                
                result = ExecutionResult(
                    success=overall_success,
                    processed_count=success_count,
                    error_count=error_count,
                    errors=errors,
                    details=details
                )
                
                # DynamoDBの状態を更新
                self._update_execution_status(diff_id, result, approved_by)
                
                # DynamoDBからmessage_tsを取得してSlack通知を送信
                diff_data = self._get_diff_data(diff_id)
                message_ts = diff_data.get('message_ts') if diff_data else None
                try:
                    self.slack_client.send_completion_notification(result, diff_id, approved_by, message_ts)
                except Exception as slack_error:
                    logger.warning(f"Slack通知送信失敗（処理は成功）: {str(slack_error)}")
                
                logger.info(f"銀行データ更新完了: {details}")
                return result
                
            except Exception as e:
                # トランザクションエラーの場合はロールバック
                conn.rollback()
                logger.error(f"トランザクションエラーでロールバック: {str(e)}")
                raise
                
        except Exception as e:
            error_msg = f"銀行データ更新エラー: {str(e)}"
            logger.error(error_msg)
            
            # エラー結果を作成
            result = ExecutionResult(
                success=False,
                processed_count=0,
                error_count=1,
                errors=[error_msg],
                details=f"システムエラー: {str(e)}"
            )
            
            # DynamoDBの状態を更新
            try:
                self._update_execution_status(diff_id, result, approved_by)
            except:
                pass  # DynamoDB更新エラーは無視
            
            # DynamoDBからmessage_tsを取得してSlack通知を送信
            diff_data = self._get_diff_data(diff_id)
            message_ts = diff_data.get('message_ts') if diff_data else None
            try:
                self.slack_client.send_completion_notification(result, diff_id, approved_by, message_ts)
            except Exception as slack_error:
                logger.warning(f"Slack通知送信失敗（エラー時）: {str(slack_error)}")
            
            return result
            
        finally:
            # データベース接続を閉じる
            self.db_client.close()
    
    def _get_diff_data(self, diff_id: str) -> Optional[Dict[str, Any]]:
        """DynamoDBから差分データを取得"""
        try:
            # まず、指定されたidのアイテムを検索（timestampが不明なため）
            response = self.table.query(
                KeyConditionExpression=boto3.dynamodb.conditions.Key('id').eq(diff_id),
                ScanIndexForward=False,  # 最新のアイテムを取得
                Limit=1
            )
            
            if response.get('Items'):
                return response['Items'][0]
            else:
                logger.warning(f"差分データが見つかりません: {diff_id}")
                return None
        except Exception as e:
            logger.error(f"差分データ取得エラー: {str(e)}")
            return None
    
    def _load_diffs_from_s3(self, s3_key: str) -> List[Dict[str, Any]]:
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
    
    def _restore_diffs(self, diffs_data: List[Dict[str, Any]]) -> List[BankDiff]:
        """差分データを復元"""
        diffs = []
        for diff_data in diffs_data:
            # BankDataオブジェクトを復元
            old_data = None
            if diff_data.get('old_data'):
                old_data = BankData(**diff_data['old_data'])
            
            new_data = None
            if diff_data.get('new_data'):
                new_data = BankData(**diff_data['new_data'])
            
            diff = BankDiff(
                action=diff_data['action'],
                key=diff_data['key'],
                old_data=old_data,
                new_data=new_data,
                total_accounts=diff_data.get('total_accounts', 0),
                active_users=diff_data.get('active_users', 0)
            )
            diffs.append(diff)
        
        return diffs
    
    def _update_execution_status(self, diff_id: str, result: ExecutionResult, approved_by: str = None):
        """DynamoDBの実行状態を更新"""
        try:
            # まず該当するアイテムのtimestampを取得
            diff_data = self._get_diff_data(diff_id)
            if not diff_data:
                logger.error(f"実行状態更新エラー: 差分データが見つかりません: {diff_id}")
                return
            
            # DynamoDBテーブルは id (partition key) + timestamp (sort key) の複合キー
            diff_timestamp = diff_data.get('timestamp')
            if not diff_timestamp:
                logger.error(f"実行状態更新エラー: timestampが見つかりません: {diff_id}")
                return
            
            update_expression = 'SET #status = :status, executed_at = :executed_at, execution_result = :result'
            expression_values = {
                ':status': 'completed' if result.success else 'failed',
                ':executed_at': datetime.now(timezone.utc).isoformat(),
                ':result': {
                    'success': result.success,
                    'processed_count': result.processed_count,
                    'error_count': result.error_count,
                    'details': result.details
                }
            }
            
            if approved_by:
                update_expression += ', executed_by = :executed_by'
                expression_values[':executed_by'] = approved_by
            
            self.table.update_item(
                Key={'id': diff_id, 'timestamp': diff_timestamp},
                UpdateExpression=update_expression,
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues=expression_values
            )
            
        except Exception as e:
            logger.error(f"実行状態更新エラー: {str(e)}")

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Lambda関数のメインハンドラー"""
    try:
        logger.info(f"差分実行処理を開始: {json.dumps(event, ensure_ascii=False)}")
        
        # パラメータを取得
        diff_id = event.get('diff_id')
        approved_by = event.get('approved_by')
        execution_type = event.get('execution_type', 'scheduled')
        
        if not diff_id:
            raise ValueError("diff_idが指定されていません")
        
        # 銀行データ更新を実行
        updater = BankUpdater()
        result = updater.execute_update(diff_id, approved_by)
        
        logger.info(f"差分実行処理完了: success={result.success}, processed={result.processed_count}")
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'success': result.success,
                'diff_id': diff_id,
                'processed_count': result.processed_count,
                'error_count': result.error_count,
                'details': result.details,
                'execution_type': execution_type
            }, ensure_ascii=False)
        }
        
    except Exception as e:
        error_message = f"差分実行処理エラー: {str(e)}"
        logger.error(f"{error_message}\n{traceback.format_exc()}")
        
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': error_message,
                'traceback': traceback.format_exc()
            }, ensure_ascii=False)
        }

if __name__ == "__main__":
    # ローカルテスト用
    test_event = {
        "diff_id": "diff-20231201-001",
        "approved_by": "test_user",
        "execution_type": "immediate"
    }
    test_context = {}
    result = handler(test_event, test_context)
    print(json.dumps(result, indent=2, ensure_ascii=False))