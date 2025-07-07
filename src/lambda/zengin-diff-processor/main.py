import json
import os
import logging
import boto3
import traceback
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, asdict
from common.slack_client import SlackClient
from common.monitoring_utils import lambda_handler_wrapper, performance_timer
import unicodedata
import hashlib
from sqlalchemy import create_engine, text
import gzip
import base64
from urllib.parse import quote_plus

# zengin-codeの動的管理
from package_manager import ZenginCodeManager


# Configure logging - will be replaced by monitoring wrapper
logger = logging.getLogger()
logger.setLevel(os.getenv('LOG_LEVEL', 'INFO'))

# SlackClientの初期インポート（通知用）
try:
    # 既存のSlackClientインスタンスがあれば利用
    slack_client_for_update = SlackClient() if os.getenv('SLACK_BOT_TOKEN') else None
except Exception as e:
    logger.warning(f"更新通知用SlackClient初期化スキップ: {str(e)}")
    slack_client_for_update = None

# zengin-codeを動的にインポート
zengin_manager = ZenginCodeManager(slack_client=slack_client_for_update)
success, error_message = zengin_manager.ensure_latest_version()

if success:
    from zengin_code import Bank
    logger.info("zengin-codeのインポートに成功しました")
else:
    # エラーメッセージがある場合は詳細を記録
    if error_message:
        logger.error(f"zengin-code管理エラー: {error_message}")
    
    # 既存バージョンで継続を試みる
    try:
        from zengin_code import Bank
        logger.warning("既存のzengin-codeバージョンで処理を継続します")
    except ImportError as e:
        # クリティカルエラー: zengin-codeが全く利用できない
        error_msg = f"zengin-codeのインポートに失敗しました: {str(e)}"
        logger.critical(error_msg)
        
        # Slack通知を試みる
        if slack_client_for_update:
            try:
                slack_client_for_update.post_message(
                    text="🚨 クリティカルエラー: zengin-codeが利用できません",
                    blocks=[
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": f"Lambda関数の実行を継続できません:\n```{error_msg}```"
                            }
                        }
                    ]
                )
            except:
                pass
        
        raise ImportError(error_msg)

# AWS clients setup
dynamodb = boto3.resource('dynamodb')
secrets_manager = boto3.client('secretsmanager')
s3 = boto3.client('s3')

# Environment variables
DIFF_TABLE_NAME = os.getenv('DIFF_TABLE_NAME')
DATABASE_SECRET_ARN = os.getenv('DATABASE_SECRET_ARN')
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
class BankUpdateRequestData:
    """更新リクエストデータ"""
    diffs: List[BankDiff]
    summary: str
    total_changes: int

class ZenginClient:
    """全銀協データ取得クライアント"""
    
    def __init__(self):
        self.bank_class = Bank
    
    def _normalize_bank_name(self, bank_name: str) -> str:
        """銀行名を正規化"""
        if not bank_name:
            return bank_name
            
        # 既に適切な接尾辞がある場合はそのまま
        suffixes = ["銀行", "信用金庫", "信用組合", "農協", "漁協", "労働金庫", "信託", "証券"]
        for suffix in suffixes:
            if bank_name.endswith(suffix):
                return bank_name
                
        # デフォルトで「銀行」を付与
        return f"{bank_name}銀行"
    
    def _normalize_branch_name(self, branch_name: str) -> str:
        """支店名を正規化"""
        if not branch_name:
            return branch_name
            
        # 既に適切な接尾辞がある場合はそのまま
        suffixes = ["支店", "営業部", "出張所", "代理店", "本店", "店舗", "センター", "プラザ"]
        for suffix in suffixes:
            if branch_name.endswith(suffix):
                return branch_name
                
        # 特殊ケース
        if branch_name in ["本店", "営業部"]:
            return branch_name
            
        # デフォルトで「支店」を付与
        return f"{branch_name}支店"

    def _convert_kana_to_hankaku(self, kana_text: str) -> str:
        """全角カタカナを半角カタカナに変換"""
        if not kana_text:
            return kana_text
            
        # NFKC正規化
        normalized = unicodedata.normalize('NFKC', kana_text)
        
        # 全角カタカナ → 半角カタカナの変換マップ
        kana_map = {
            'ア': 'ｱ', 'イ': 'ｲ', 'ウ': 'ｳ', 'エ': 'ｴ', 'オ': 'ｵ',
            'カ': 'ｶ', 'キ': 'ｷ', 'ク': 'ｸ', 'ケ': 'ｹ', 'コ': 'ｺ',
            'サ': 'ｻ', 'シ': 'ｼ', 'ス': 'ｽ', 'セ': 'ｾ', 'ソ': 'ｿ',
            'タ': 'ﾀ', 'チ': 'ﾁ', 'ツ': 'ﾂ', 'テ': 'ﾃ', 'ト': 'ﾄ',
            'ナ': 'ﾅ', 'ニ': 'ﾆ', 'ヌ': 'ﾇ', 'ネ': 'ﾈ', 'ノ': 'ﾉ',
            'ハ': 'ﾊ', 'ヒ': 'ﾋ', 'フ': 'ﾌ', 'ヘ': 'ﾍ', 'ホ': 'ﾎ',
            'マ': 'ﾏ', 'ミ': 'ﾐ', 'ム': 'ﾑ', 'メ': 'ﾒ', 'モ': 'ﾓ',
            'ヤ': 'ﾔ', 'ユ': 'ﾕ', 'ヨ': 'ﾖ',
            'ラ': 'ﾗ', 'リ': 'ﾘ', 'ル': 'ﾙ', 'レ': 'ﾚ', 'ロ': 'ﾛ',
            'ワ': 'ﾜ', 'ヲ': 'ｦ', 'ン': 'ﾝ',
            'ァ': 'ｧ', 'ィ': 'ｨ', 'ゥ': 'ｩ', 'ェ': 'ｪ', 'ォ': 'ｫ',
            'ッ': 'ｯ', 'ャ': 'ｬ', 'ュ': 'ｭ', 'ョ': 'ｮ',
            'ガ': 'ｶﾞ', 'ギ': 'ｷﾞ', 'グ': 'ｸﾞ', 'ゲ': 'ｹﾞ', 'ゴ': 'ｺﾞ',
            'ザ': 'ｻﾞ', 'ジ': 'ｼﾞ', 'ズ': 'ｽﾞ', 'ゼ': 'ｾﾞ', 'ゾ': 'ｿﾞ',
            'ダ': 'ﾀﾞ', 'ヂ': 'ﾁﾞ', 'ヅ': 'ﾂﾞ', 'デ': 'ﾃﾞ', 'ド': 'ﾄﾞ',
            'バ': 'ﾊﾞ', 'ビ': 'ﾋﾞ', 'ブ': 'ﾌﾞ', 'ベ': 'ﾍﾞ', 'ボ': 'ﾎﾞ',
            'パ': 'ﾊﾟ', 'ピ': 'ﾋﾟ', 'プ': 'ﾌﾟ', 'ペ': 'ﾍﾟ', 'ポ': 'ﾎﾟ',
            'ヴ': 'ｳﾞ',
            '－': 'ｰ', 'ー': 'ｰ'
        }
        
        result = ""
        for char in normalized:
            result += kana_map.get(char, char)
        
        return result

    def get_all_banks(self) -> List[BankData]:
        """zengin-codeから全ての銀行データを取得（模擬実装）"""
        try:
            all_banks = self.bank_class.all
            
            bank_data_list = []
            for bank_code, bank_info in all_banks.items():
                # 銀行の基本情報を正規化
                bank_name = self._normalize_bank_name(bank_info.name)
                bank_name_kana = self._convert_kana_to_hankaku(bank_info.kana)
                
                # 各支店のデータを取得
                if hasattr(bank_info, 'branches') and bank_info.branches:
                    for branch_code, branch_info in bank_info.branches.items():
                        branch_name = self._normalize_branch_name(branch_info.name)
                        bank_data = BankData(
                            swift_code=bank_code,
                            bank_name=bank_name,
                            bank_name_kana=bank_name_kana,
                            branch_code=branch_code,
                            branch_name=branch_name,
                            branch_name_kana=self._convert_kana_to_hankaku(branch_info.kana)
                        )
                        bank_data_list.append(bank_data)
                else:
                    # 支店情報がない場合は銀行本体のデータのみ
                    bank_data = BankData(
                        swift_code=bank_code,
                        bank_name=bank_name,
                        bank_name_kana=bank_name_kana,
                        branch_code="001",  # デフォルトの本店コード
                        branch_name="本店",
                        branch_name_kana=self._convert_kana_to_hankaku("ホンテン")
                    )
                    bank_data_list.append(bank_data)
            
            logger.info(f"取得した銀行データ件数: {len(bank_data_list)}")
            return bank_data_list
            
        except Exception as e:
            logger.error(f"zengin_codeからのデータ取得エラー: {str(e)}")
            raise

class DatabaseClient:
    """データベースクライアント - PostgreSQL via SQLAlchemy"""
    
    def __init__(self):
        self.db_credentials: Optional[Dict[str, Any]] = None
        self._engine = None
    
    def _get_db_credentials(self) -> Dict[str, Any]:
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
    
    def _get_engine(self):
        """Create or return cached SQLAlchemy engine"""
        if self._engine:
            return self._engine
        creds = self._get_db_credentials()
        host = creds.get("host") or creds.get("endpoint")
        port = creds.get("port", 5432)
        dbname = creds.get("name") or creds.get("dbname") or creds.get("database")
        user = creds.get("username") or creds.get("user")
        password = creds.get("password") or creds.get("secret")
        
        # デバッグ用ログ（パスワードの一部をマスク）
        logger.info(f"Database connection info - Host: {host}, Port: {port}, Database: {dbname}, User: {user}")
        logger.info(f"Password length: {len(password)}, First 3 chars: {password[:3] if password else 'None'}...")
        logger.info(f"Password repr: {repr(password[:10])}...")  # 特殊文字確認用
        logger.info(f"Password ends with: {repr(password[-3:])}")  # 末尾の文字確認
        
        # URLエンコードを行わず、connect_argsで直接渡す
        db_url = f"postgresql+psycopg2://{host}:{port}/{dbname}"
        self._engine = create_engine(
            db_url,
            pool_pre_ping=True,
            connect_args={
                "user": user,
                "password": password,
                "sslmode": "require"
            }
        )
        return self._engine

    def get_mbank_data(self) -> List[Dict[str, Any]]:
        """現在のMBankデータを取得"""
        try:
            engine = self._get_engine()
            with engine.connect() as conn:
                result = conn.execute(
                    text(
                        """
                        SELECT swift_code, bank_name, bank_name_kana, branch_code, branch_name, branch_name_kana
                        FROM m_bank
                        WHERE is_deleted = 0
                        """
                    )
                )
                data = [dict(row._mapping) for row in result]
                logger.info(f"MBankデータ件数: {len(data)}")
                return data
        except Exception as e:
            logger.error(f"MBankデータ取得エラー: {str(e)}")
            raise
    
    def get_user_bank_account_impact_stats(self, swift_code: str, branch_code: str) -> Dict[str, int]:
        """指定された銀行支店コードに紐づくUserBankAccountの影響統計を取得"""
        engine = self._get_engine()
        try:
            with engine.connect() as conn:
                result = conn.execute(
                    text(
                        """
                        SELECT 
                            COUNT(uba.id)                    AS total_accounts,
                            COUNT(DISTINCT uba.user_id)      AS total_users,
                            COUNT(CASE WHEN u.use_status = 1 THEN 1 END)             AS active_user_accounts,
                            COUNT(DISTINCT CASE WHEN u.use_status = 1 THEN uba.user_id END) AS active_users
                        FROM user_bank_account uba
                        LEFT JOIN "user" u ON uba.user_id = u.id
                        WHERE uba.bank_swift_code = :swift_code
                          AND uba.branch_code = :branch_code
                          AND uba.is_deleted = 0
                        """
                    ),
                    {"swift_code": swift_code, "branch_code": branch_code},
                )
                row = result.fetchone()
                if not row:
                    return {"total_accounts": 0, "active_users": 0}
                return {
                    "total_accounts": row.total_accounts or 0,
                    "active_users": row.active_users or 0,
                }
        except Exception as e:
            logger.error(f"影響統計取得エラー: {str(e)}")
            return {"total_accounts": 0, "active_users": 0}
    
    def get_user_bank_account_impact_stats_batch(self, bank_branch_pairs: List[tuple]) -> Dict[str, Dict[str, int]]:
        """複数の銀行支店コードに紐づくUserBankAccountの影響統計を一括取得"""
        if not bank_branch_pairs:
            return {}
        
        engine = self._get_engine()
        try:
            with engine.connect() as conn:
                # Create a temporary table for the batch query
                values_clause = ", ".join([f"('{swift}', '{branch}')" for swift, branch in bank_branch_pairs])
                
                result = conn.execute(
                    text(f"""
                        WITH bank_codes AS (
                            SELECT * FROM (VALUES {values_clause}) AS t(swift_code, branch_code)
                        )
                        SELECT 
                            uba.bank_swift_code,
                            uba.branch_code,
                            COUNT(uba.id) AS total_accounts,
                            COUNT(DISTINCT uba.user_id) AS total_users,
                            COUNT(CASE WHEN u.use_status = 1 THEN 1 END) AS active_user_accounts,
                            COUNT(DISTINCT CASE WHEN u.use_status = 1 THEN uba.user_id END) AS active_users
                        FROM bank_codes bc
                        LEFT JOIN user_bank_account uba 
                            ON uba.bank_swift_code = bc.swift_code 
                            AND uba.branch_code = bc.branch_code
                            AND uba.is_deleted = 0
                        LEFT JOIN "user" u ON uba.user_id = u.id
                        GROUP BY uba.bank_swift_code, uba.branch_code
                    """)
                )
                
                # Build result dictionary
                stats_dict = {}
                for row in result:
                    if row.bank_swift_code and row.branch_code:
                        key = f"{row.bank_swift_code}-{row.branch_code}"
                        stats_dict[key] = {
                            "total_accounts": row.total_accounts or 0,
                            "active_users": row.active_users or 0,
                        }
                
                # Fill in zeros for any missing entries
                for swift, branch in bank_branch_pairs:
                    key = f"{swift}-{branch}"
                    if key not in stats_dict:
                        stats_dict[key] = {"total_accounts": 0, "active_users": 0}
                
                return stats_dict
                
        except Exception as e:
            logger.error(f"一括影響統計取得エラー: {str(e)}")
            # Return zeros for all entries on error
            return {f"{swift}-{branch}": {"total_accounts": 0, "active_users": 0} 
                    for swift, branch in bank_branch_pairs}

class DiffDetector:
    """差分検出サービス"""
    
    def __init__(self):
        self.zengin_client = ZenginClient()
        self.db_client = DatabaseClient()
    
    def detect_differences(self) -> BankUpdateRequestData:
        """差分検出メイン処理"""
        logger.info("差分検出を開始")
        
        try:
            # 現在のMBankデータを取得
            current_data = self.db_client.get_mbank_data()
            current_dict = {f"{item['swift_code']}-{item['branch_code']}": item 
                           for item in current_data}
            
            # zengin-codeから最新データを取得
            latest_data = self.zengin_client.get_all_banks()
            latest_dict = {f"{item.swift_code}-{item.branch_code}": item 
                          for item in latest_data}
            
            diffs = []
            bank_codes_for_impact = []  # 影響統計が必要な銀行コードのリスト
            
            # 新規追加と更新を検出
            for key, new_item in latest_dict.items():
                if key not in current_dict:
                    # 新規追加
                    diff = BankDiff(
                        action="create",
                        key=key,
                        old_data=None,
                        new_data=new_item
                    )
                    diffs.append(diff)
                else:
                    # 更新チェック
                    current_item = current_dict[key]
                    if self._is_data_different(current_item, new_item):
                        old_data = BankData(**current_item)
                        diff = BankDiff(
                            action="update",
                            key=key,
                            old_data=old_data,
                            new_data=new_item,
                            total_accounts=0,  # 後で一括更新
                            active_users=0  # 後で一括更新
                        )
                        diffs.append(diff)
                        bank_codes_for_impact.append((new_item.swift_code, new_item.branch_code))
            
            # 削除を検出
            for key, current_item in current_dict.items():
                if key not in latest_dict:
                    old_data = BankData(**current_item)
                    diff = BankDiff(
                        action="delete",
                        key=key,
                        old_data=old_data,
                        new_data=None,
                        total_accounts=0,  # 後で一括更新
                        active_users=0  # 後で一括更新
                    )
                    diffs.append(diff)
                    bank_codes_for_impact.append((old_data.swift_code, old_data.branch_code))
            
            # 影響統計を一括取得
            if bank_codes_for_impact:
                logger.info(f"影響統計を一括取得: {len(bank_codes_for_impact)}件")
                impact_stats = self.db_client.get_user_bank_account_impact_stats_batch(bank_codes_for_impact)
                
                # 差分に影響統計を適用
                for diff in diffs:
                    if diff.action in ["update", "delete"]:
                        stats = impact_stats.get(diff.key, {"total_accounts": 0, "active_users": 0})
                        diff.total_accounts = stats["total_accounts"]
                        diff.active_users = stats["active_users"]
            
            # サマリーを作成
            summary = self._create_summary(diffs)
            
            logger.info(f"差分検出完了: {len(diffs)}件の差分を検出")
            
            return BankUpdateRequestData(
                diffs=diffs,
                summary=summary,
                total_changes=len(diffs)
            )
            
        except Exception as e:
            logger.error(f"差分検出エラー: {str(e)}")
            raise
    
    def _is_data_different(self, current: Dict, new: BankData) -> bool:
        """データが異なるかどうかを判定"""
        fields_to_check = [
            'bank_name', 'bank_name_kana', 'branch_name', 'branch_name_kana'
        ]
        suffix_sets: list[list[str]] = [["支店", "支所", "出張所"]]
        flat_suffixes = set(sum(suffix_sets, []))

        def split_suffix(name: str):
            for s in flat_suffixes:
                if name.endswith(s):
                    return name[:-len(s)].strip(), s
            return name.strip(), ''

        def is_equivalent_suffix(s1: str, s2: str) -> bool:
            if s1 == s2:
                return True
            for group in suffix_sets:
                if s1 in group and s2 in group:
                    return True
            return False

        for field in fields_to_check:
            current_value = current.get(field)
            new_value = getattr(new, field)

            # None 正規化
            if current_value is None:
                current_value = ""
            if new_value is None:
                new_value = ""

            # カナフィールドは半角カナ比較
            if field.endswith('_kana'):
                current_value = self.zengin_client._convert_kana_to_hankaku(str(current_value))
                new_value = self.zengin_client._convert_kana_to_hankaku(str(new_value))

            # 特殊: branch_name の suffix 同義語処理
            if field == 'branch_name':
                base_cur, suf_cur = split_suffix(str(current_value))
                base_new, suf_new = split_suffix(str(new_value))
                if base_cur != base_new:
                    return True
                if suf_cur == suf_new or is_equivalent_suffix(suf_cur, suf_new) or suf_cur == '' or suf_new == '':
                    continue
                return True
            else:
                if str(current_value).strip() != str(new_value).strip():
                    return True

        return False
    
    def _create_summary(self, diffs: List[BankDiff]) -> str:
        """差分のサマリーを作成"""
        create_count = len([d for d in diffs if d.action == "create"])
        update_count = len([d for d in diffs if d.action == "update"])
        delete_count = len([d for d in diffs if d.action == "delete"])
        
        # UserBankAccount影響統計
        total_affected_accounts = sum(
            diff.total_accounts for diff in diffs if diff.action in ["update", "delete"]
        )
        total_active_users = sum(
            diff.active_users for diff in diffs if diff.action in ["update", "delete"]
        )
        
        summary_parts = []
        if create_count > 0:
            summary_parts.append(f"新規追加: {create_count}件")
        if update_count > 0:
            summary_parts.append(f"更新: {update_count}件")
        if delete_count > 0:
            summary_parts.append(f"削除: {delete_count}件")
        
        if not summary_parts:
            return "変更なし"
        
        base_summary = "、".join(summary_parts)
        
        # 影響するアカウントがある場合は追記
        if total_affected_accounts > 0:
            base_summary += f" (UserBankAccount影響: {total_affected_accounts}件、稼働ユーザー: {total_active_users}名)"
        
        return base_summary


def store_diff_data_to_s3(diff_id: str, diffs: List[BankDiff]) -> str:
    """大きな差分データをS3に保存"""
    try:
        # 差分データをJSON形式に変換
        diffs_data = [asdict(diff) for diff in diffs]
        diffs_json = json.dumps(diffs_data, ensure_ascii=False)
        
        # gzipで圧縮
        compressed_data = gzip.compress(diffs_json.encode('utf-8'))
        
        # S3キーを生成
        s3_key = f"diffs/{ENVIRONMENT}/{diff_id}/full_diffs.json.gz"
        
        # S3にアップロード
        s3.put_object(
            Bucket=S3_BUCKET_NAME,
            Key=s3_key,
            Body=compressed_data,
            ContentType='application/json',
            ContentEncoding='gzip',
            Metadata={
                'diff_id': diff_id,
                'original_size': str(len(diffs_json)),
                'compressed_size': str(len(compressed_data)),
                'diff_count': str(len(diffs))
            }
        )
        
        logger.info(f"差分データをS3に保存: s3://{S3_BUCKET_NAME}/{s3_key}")
        return s3_key
        
    except Exception as e:
        logger.error(f"S3保存エラー: {str(e)}")
        raise

def check_recent_execution() -> Optional[Dict[str, Any]]:
    """過去5分以内の実行があるかチェック"""
    try:
        from datetime import datetime, timezone, timedelta
        
        # 5分前の時刻を計算
        five_minutes_ago = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        
        # DynamoDBから最近の実行をチェック
        table = dynamodb.Table(DIFF_TABLE_NAME)
        response = table.scan(
            FilterExpression='#status = :status AND #timestamp > :recent_time',
            ExpressionAttributeNames={
                '#status': 'status',
                '#timestamp': 'timestamp'
            },
            ExpressionAttributeValues={
                ':status': 'pending',
                ':recent_time': five_minutes_ago
            },
            Limit=1  # 1件でも見つかれば十分
        )
        
        if response.get('Items'):
            return response['Items'][0]
        return None
        
    except Exception as e:
        logger.error(f"重複実行チェックエラー: {str(e)}")
        return None

def store_diff_data(update_request: BankUpdateRequestData, message_ts: str | None = None) -> str:
    """差分データをDynamoDBに保存"""
    try:
        table = dynamodb.Table(DIFF_TABLE_NAME)
        
        # 一意なIDを生成
        timestamp = datetime.now(timezone.utc).isoformat()
        diff_id = f"diff-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        
        # 全ての差分データをS3に保存
        diffs_data = [asdict(diff) for diff in update_request.diffs]
        diffs_json = json.dumps(diffs_data, ensure_ascii=False)
        data_size = len(diffs_json.encode('utf-8'))
        logger.info(f"差分データサイズ: {data_size / 1024:.2f}KB")
        
        # S3に全データを保存（サイズに関わらず統一処理）
        s3_key = store_diff_data_to_s3(diff_id, update_request.diffs)
        
        # DynamoDBには要約情報のみを保存（表示用）
        summary_diffs = []
        for diff in update_request.diffs[:10]:  # 最初の10件のみ表示用に保存
            summary_diff = {
                'action': diff.action,
                'key': diff.key,
                'swift_code': diff.new_data.swift_code if diff.new_data else diff.old_data.swift_code,
                'bank_name': diff.new_data.bank_name if diff.new_data else diff.old_data.bank_name,
                'branch_code': diff.new_data.branch_code if diff.new_data else diff.old_data.branch_code,
                'branch_name': diff.new_data.branch_name if diff.new_data else diff.old_data.branch_name,
            }
            summary_diffs.append(summary_diff)
        
        # DynamoDBアイテムを構築（S3参照版）
        item = {
            'id': diff_id,
            'timestamp': timestamp,
            'status': 'pending',
            'summary': update_request.summary,
            'total_changes': update_request.total_changes,
            'diffs': summary_diffs,  # 表示用の要約データ
            'diffs_s3_key': s3_key,  # S3の完全データへの参照
            'original_diff_count': len(update_request.diffs),
            'message_ts': message_ts,
            'environment': ENVIRONMENT,
            'ttl': int((datetime.now(timezone.utc).timestamp() + 30 * 24 * 60 * 60))  # 30日後にTTL
        }
        
        # DynamoDBに保存
        table.put_item(Item=item)
        
        logger.info(f"差分データをDynamoDBに保存: {diff_id}")
        return diff_id
        
    except Exception as e:
        logger.error(f"DynamoDB保存エラー: {str(e)}")
        raise

@lambda_handler_wrapper('zengin-diff-processor')
def handler(event: Dict[str, Any], context: Any, logger, metrics) -> Dict[str, Any]:
    """Lambda関数のメインハンドラー"""
    try:
        import uuid
        from datetime import datetime, timezone
        execution_id = str(uuid.uuid4())[:8]
        logger.info(f"差分処理を開始 [実行ID: {execution_id}]", event_type="function_start", event_data=event, execution_id=execution_id)
        
        # zengin-codeのバージョン情報をログ出力
        try:
            import zengin_code
            zengin_version = getattr(zengin_code, '__version__', 'unknown')
            logger.info(f"zengin-codeバージョン: {zengin_version}", execution_id=execution_id)
            metrics.emit_business_metric('ZenginCodeVersion', {'version': zengin_version})
        except Exception as e:
            logger.warning(f"zengin-codeバージョン情報取得エラー: {str(e)}", execution_id=execution_id)
        
        # 実行ロックを確認・設定（重複実行防止）
        lock_key = f"diff-processor-lock-{datetime.now(timezone.utc).strftime('%Y-%m-%d-%H')}"
        try:
            # 重複実行チェック（過去5分以内の実行があるかチェック）
            recent_execution = check_recent_execution()
            if recent_execution:
                logger.warning(f"最近の実行を検出 [実行ID: {execution_id}] - スキップ", 
                             recent_execution=recent_execution, execution_id=execution_id)
                return {
                    'statusCode': 200,
                    'body': json.dumps({
                        'message': '最近の実行が検出されたためスキップ',
                        'recent_execution': recent_execution
                    }, ensure_ascii=False)
                }
        except Exception as e:
            logger.warning(f"重複実行チェックエラー [実行ID: {execution_id}]: {str(e)}", execution_id=execution_id)
        
        # 差分検出の実行
        with performance_timer(logger, metrics, 'diff_detection'):
            diff_detector = DiffDetector()
            update_request = diff_detector.detect_differences()
        
        if update_request.total_changes == 0:
            logger.info(f"変更なし [実行ID: {execution_id}]", total_changes=0, execution_id=execution_id)
            metrics.emit_business_metric('NoChangesDetected')
            
            # Slack通知を送信 (変更なし)
            slack_client = SlackClient()
            slack_client.send_no_changes_notification()
            logger.info(f"変更なし通知送信完了 [実行ID: {execution_id}]", execution_id=execution_id)
            
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': '変更なし',
                    'total_changes': 0
                }, ensure_ascii=False)
            }
        
        # Slack通知を送信 via Bot Token
        with performance_timer(logger, metrics, 'slack_notification'):
            slack_client = SlackClient()
            logger.info(f"Slack通知送信開始 [実行ID: {execution_id}] - 変更数: {update_request.total_changes}", execution_id=execution_id)
            notification_result = slack_client.send_diff_notification(update_request)
            message_ts = notification_result.get('ts') if isinstance(notification_result, dict) else None
            logger.info(f"Slack通知送信完了 [実行ID: {execution_id}] - message_ts: {message_ts}", execution_id=execution_id)
        
        # 差分データをDynamoDBに保存
        with performance_timer(logger, metrics, 'dynamodb_save'):
            diff_id = store_diff_data(update_request, message_ts=message_ts)
        
        # CSV ファイルを作成してSlackに送信
        csv_upload_result = None
        if message_ts and notification_result.get('ok'):
            with performance_timer(logger, metrics, 'csv_upload'):
                try:
                    csv_file_id = slack_client.send_csv_diff(update_request, message_ts)
                    csv_upload_result = {'file_id': csv_file_id, 'status': 'success'}
                    logger.info(f"CSV uploaded to Slack thread: {csv_file_id}")
                except Exception as e:
                    logger.error(f"CSV upload error: {str(e)}")
                    csv_upload_result = {'status': 'error', 'error': str(e)}
        
        # ビジネスメトリクスを送信
        metrics.emit_business_metric('DiffProcessingCompleted')
        metrics.emit_count_metric('ChangesDetected', update_request.total_changes)
        
        logger.info(f"差分処理完了 [実行ID: {execution_id}]", 
                   total_changes=update_request.total_changes,
                   diff_id=diff_id,
                   slack_message_ts=message_ts,
                   execution_id=execution_id)
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': '差分検出・通知完了',
                'diff_id': diff_id,
                'total_changes': update_request.total_changes,
                'summary': update_request.summary,
                'notification_result': notification_result,
                'csv_upload_result': csv_upload_result
            }, ensure_ascii=False)
        }
        
    except Exception as e:
        error_type = type(e).__name__
        error_message = f"差分処理エラー: {str(e)}"
        
        logger.error("差分処理エラーが発生", 
                    error=error_message,
                    error_type=error_type,
                    traceback=traceback.format_exc())
        
        metrics.emit_error_metric(error_type, {'Operation': 'diff_processing'})
        
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': error_message,
                'error_type': error_type
            }, ensure_ascii=False)
        }

if __name__ == "__main__":
    # ローカルテスト用
    test_event = {"trigger": "manual"}
    test_context = {}
    result = handler(test_event, test_context)
    print(json.dumps(result, indent=2, ensure_ascii=False))