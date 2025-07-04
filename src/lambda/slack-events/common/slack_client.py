import os
import logging
import json
from typing import Any, Dict, List, TYPE_CHECKING
import boto3

try:
    from slack_sdk import WebClient
    from slack_sdk.errors import SlackApiError
except ImportError:  # Runtime environments where slack_sdk is not yet available
    WebClient = None  # type: ignore
    SlackApiError = Exception  # type: ignore

if TYPE_CHECKING:
    from ..main import BankUpdateRequestData
else:
    try:
        from main import BankUpdateRequestData
    except ImportError:
        BankUpdateRequestData = Any

logger = logging.getLogger(__name__)
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

# AWS clients
secrets_manager = boto3.client('secretsmanager')


import csv
import tempfile
import os
from datetime import datetime

import pytz

# JST timezone
JST = pytz.timezone("Asia/Tokyo")


def now_jst():
    """Get current time in JST"""
    return datetime.now(JST)


class SlackClient:
    """Slack Bot Token based client providing rich Slack interactions.

    This implementation centralizes all Slack-related functionality for lambda
    functions, such as posting diff notifications, updating messages, sending
    CSV exports, and various helper alerts.  It is a consolidated version of
    the previous SlackNotifier/Webhook implementation now using `slack_sdk`'s
    `WebClient`.
    """

    def __init__(self) -> None:
        self.token_secret_arn = os.getenv("SLACK_BOT_TOKEN")
        self.channel_id = os.getenv("SLACK_CHANNEL_ID")
        self.token = None
        
        # タイムアウト設定を環境変数から取得
        self.timeout = int(os.getenv("SLACK_API_TIMEOUT", "30"))

        if not self.token_secret_arn or not self.channel_id:
            logger.warning(
                "Slack bot token or channel ID not configured. Slack notifications will be skipped."
            )
            self.client = None
        elif WebClient is None:
            logger.warning(
                "slack_sdk is not installed in the execution environment. Slack notifications will be skipped."
            )
            self.client = None
        else:
            # Retrieve bot token from Secrets Manager
            try:
                self.token = self._get_bot_token()
                # タイムアウトを設定
                self.client = WebClient(
                    token=self.token,
                    timeout=self.timeout
                )
            except Exception as e:
                logger.error(f"Failed to retrieve Slack bot token: {str(e)}")
                self.client = None
    
    def _get_bot_token(self) -> str:
        """Retrieve Slack bot token from Secrets Manager"""
        try:
            response = secrets_manager.get_secret_value(SecretId=self.token_secret_arn)
            secret_data = json.loads(response['SecretString'])
            # The bot token might be stored directly or in a specific key
            if isinstance(secret_data, dict):
                return secret_data.get('token', secret_data.get('bot_token', secret_data.get('botToken', '')))
            else:
                return secret_data
        except Exception as e:
            logger.error(f"Error retrieving bot token from Secrets Manager: {str(e)}")
            raise

    def send_diff_notification(self, update_request: Any) -> Dict[str, Any]:
        """Post a diff notification to Slack.

        Parameters
        ----------
        update_request: Any
            The BankUpdateRequestData (or compatible) object containing the
            diff summary. Only ``summary`` and ``total_changes`` attributes are
            required for this minimal implementation.
        """
        if self.client is None:
            logger.info("Slack client unavailable – skipping Slack notification.")
            return {"ok": False, "skipped": True}

        try:
            # メッセージブロックを構築
            blocks = self._build_notification_blocks(update_request)

            # Slackにメッセージを送信
            response = self.client.chat_postMessage(
                channel=self.channel_id,
                text=f"全銀データの更新が検出されました: {update_request.summary}",
                blocks=blocks,
            )
            logger.info("Posted diff notification to Slack. ts=%s", response["ts"])
            return response.data if hasattr(response, "data") else response

        except SlackApiError as e:
            logger.error("Slack API error: %s", str(e))
            return {"ok": False, "error": str(e)}
        except Exception as exc:
            logger.error("Unexpected error posting to Slack: %s", str(exc))
            return {"ok": False, "error": str(exc)}

    def _build_notification_blocks(self, update_request: BankUpdateRequestData) -> List[Dict[str, Any]]:
        """Slack通知用のブロックを構築"""
        blocks = [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": "🏦 全銀データ更新通知"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*概要:* {update_request.summary}\n*変更件数:* {update_request.total_changes}件"
                }
            },
            {
                "type": "divider"
            }
        ]
        
        # 差分の詳細を追加（最大5件まで表示）
        if update_request.diffs:
            blocks.append({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "*変更詳細:*"
                }
            })
            
            for i, diff in enumerate(update_request.diffs[:5]):
                blocks.append(self._create_diff_block(diff))
            
            if len(update_request.diffs) > 5:
                blocks.append({
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"...他 {len(update_request.diffs) - 5}件"
                    }
                })
        
        # 承認ボタンを追加
        blocks.extend([
            {
                "type": "divider"
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "*この更新を承認しますか？*"
                }
            },
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "✅ 承認（23:00実行）"
                        },
                        "style": "primary",
                        "action_id": "approve_update",
                        "value": json.dumps({
                            "action": "approve",
                            "execution_time": "23:00"
                        })
                    },
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "⏰ 1時間後"
                        },
                        "action_id": "approve_1h",
                        "value": json.dumps({
                            "action": "approve_1h",
                            "execution_time": "1h"
                        })
                    },
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "⏰ 3時間後"
                        },
                        "action_id": "approve_3h",
                        "value": json.dumps({
                            "action": "approve_3h", 
                            "execution_time": "3h"
                        })
                    }
                ]
            },
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "⏰ 5時間後"
                        },
                        "action_id": "approve_5h",
                        "value": json.dumps({
                            "action": "approve_5h",
                            "execution_time": "5h"
                        })
                    },
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "🚀 即時実行"
                        },
                        "style": "primary",
                        "action_id": "approve_immediate",
                        "value": json.dumps({
                            "action": "approve_immediate",
                            "execution_time": "immediate"
                        })
                    },
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "❌ 却下"
                        },
                        "style": "danger",
                        "action_id": "reject_update",
                        "value": json.dumps({
                            "action": "reject"
                        })
                    }
                ]
            }
        ])
        
        return blocks
    
    def _create_diff_block(self, diff: Any) -> Dict[str, Any]:
        """差分詳細のブロックを作成"""
        # アクションに応じたアイコンとテキスト
        action_icons = {
            "create": "🆕",
            "update": "✏️",
            "delete": "🗑️"
        }
        
        icon = action_icons.get(diff.action, "❓")
        
        # 銀行・支店情報を取得
        if diff.new_data:
            bank_name = diff.new_data.bank_name
            branch_name = diff.new_data.branch_name
            swift_code = diff.new_data.swift_code
            branch_code = diff.new_data.branch_code
        else:
            bank_name = diff.old_data.bank_name if diff.old_data else "不明"
            branch_name = diff.old_data.branch_name if diff.old_data else "不明"
            swift_code = diff.old_data.swift_code if diff.old_data else "不明"
            branch_code = diff.old_data.branch_code if diff.old_data else "不明"
        
        # 影響範囲のテキスト
        impact_text = ""
        if diff.total_accounts > 0:
            impact_text = f" (影響: {diff.total_accounts}アカウント"
            if diff.active_users > 0:
                impact_text += f", {diff.active_users}名稼働中"
            impact_text += ")"
        
        # 変更内容の詳細
        change_details = []
        if diff.action == "update" and diff.old_data and diff.new_data:
            if diff.old_data.bank_name != diff.new_data.bank_name:
                change_details.append(f"銀行名: {diff.old_data.bank_name} → {diff.new_data.bank_name}")
            if diff.old_data.branch_name != diff.new_data.branch_name:
                change_details.append(f"支店名: {diff.old_data.branch_name} → {diff.new_data.branch_name}")
        
        text = f"{icon} *{bank_name} {branch_name}* ({swift_code}-{branch_code}){impact_text}"
        if change_details:
            text += "\n" + "\n".join(f"  • {detail}" for detail in change_details)
        
        return {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": text
            }
        }

    def update_message_with_result(
        self,
        message_ts: str,
        approved: bool,
        user_name: str,
        scheduled_time: str | None = None,
        execution_type: str = "scheduled",
    ) -> None:
        """Update original notification with approval / rejection results."""
        if self.client is None:
            logger.info("Slack client unavailable – skip update_message_with_result")
            return

        if approved:
            if execution_type == "immediate":
                status_text = f"🚀 *即時実行承認* by {user_name}\n処理が完了しました。詳細はスレッドを確認して下さい"
            elif execution_type == "custom":
                status_text = f"⏰ *カスタム時間承認* by {user_name}\n実行予定時刻: {scheduled_time}"
            else:
                status_text = f"✅ *承認済み* by {user_name}\n実行予定時刻: {scheduled_time or '23:00'}"
            color = "good"
        else:
            status_text = f"❌ *却下済み* by {user_name}\n処理を中止しました。"
            color = "danger"

        blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": status_text}}]
        try:
            self.client.chat_update(
                channel=self.channel_id,
                ts=message_ts,
                text=status_text,
                blocks=blocks,
                attachments=[{"color": color}],
            )
        except SlackApiError as e:
            logger.error("Slack message update error: %s", e.response.get("error"))
            raise


    def upload_csv_to_slack(
        self, file_path: str, message_ts: str, filename: str | None = None
    ) -> str:
        if self.client is None:
            return ""
        if not filename:
            filename = f"zengin_diff_{now_jst().strftime('%Y%m%d_%H%M%S')}.csv"
        try:
            response = self.client.files_upload_v2(
                channel=self.channel_id,
                file=file_path,
                filename=filename,
                title="全銀データ差分一覧",
                initial_comment="📄 全ての差分データをCSVファイルで出力しました。",
                thread_ts=message_ts,
            )
            return response["file"]["id"]
        finally:
            try:
                os.unlink(file_path)
            except Exception:
                pass

    def send_no_changes_notification(self):
        if self.client is None:
            return None
        now_dt = now_jst()
        now_txt = now_dt.strftime("%Y-%m-%d %H:%M:%S")

        # 次回の定期チェック（翌月1日の1時）を計算
        if now_dt.month == 12:
            next_year = now_dt.year + 1
            next_month = 1
        else:
            next_year = now_dt.year
            next_month = now_dt.month + 1

        # pytzのタイムゾーン情報を付与
        next_run_dt = JST.localize(datetime(next_year, next_month, 1, 1, 0, 0))
        next_run_txt = next_run_dt.strftime("%Y-%m-%d %H:%M:%S")

        blocks = [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"ℹ️ *全銀データ更新チェック完了*\n銀行情報の更新はありませんでした\n*チェック時刻*: {now_txt} JST",
                },
            },
            {
                "type": "context",
                "elements": [
                    {
                        "type": "mrkdwn",
                        "text": f"次回の定期チェック: {next_run_txt} JST",
                    }
                ],
            },
        ]
        resp = self.client.chat_postMessage(
            channel=self.channel_id,
            text="銀行情報の更新はありませんでした",
            blocks=blocks,
        )
        return resp["ts"]

    def send_error_notification(
        self,
        error_type: str,
        error_message: str,
        details: dict | None = None,
        message_ts: str | None = None,
    ) -> str | None:
        if self.client is None:
            return None
        error_text = f"🚨 *エラー発生*\n*タイプ*: {error_type}\n*メッセージ*: {error_message}\n"
        if details:
            error_text += (
                "*詳細*:\n"
                + "\n".join(f"• {k}: {v}" for k, v in details.items())
                + "\n"
            )
        try:
            error_text += f"*時刻*: {now_jst().strftime('%Y-%m-%d %H:%M:%S')} JST"
            resp = self.client.chat_postMessage(
                channel=self.channel_id,
                text=error_text,
                thread_ts=message_ts,
            )
            return resp["ts"]
        except Exception as e:
            logger.error(f"Slackエラー通知送信エラー: {str(e)}")

    def update_message_with_error(
        self,
        message_ts: str,
        error_message: str,
        user_name: str | None = None,
        retry_possible: bool = False,
    ) -> None:
        if self.client is None:
            return
        text = f"❌ *処理エラー*{f' (要求者: {user_name})' if user_name else ''}\n{error_message}"
        if retry_possible:
            text += "\n💡 処理を再実行するには、新しく承認操作を行ってください。"
        blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": text}}]
        self.client.chat_update(channel=self.channel_id, ts=message_ts, blocks=blocks)

    def send_duplicate_action_warning(
        self, message_ts: str, user_name: str, action_type: str
    ):
        if self.client is None:
            return
        warn_txt = (
            f"⚠️ *重複操作検知*\n*ユーザー*: {user_name}\n*操作*: {action_type}\n"
            f"*メッセージ*: この処理は既に実行済みです。\n*時刻*: {now_jst().strftime('%Y-%m-%d %H:%M:%S')} JST"
        )
        try:
            self.client.chat_postMessage(
                channel=self.channel_id, thread_ts=message_ts, text=warn_txt
            )
        except Exception as e:
            logger.error(f"Slack重複操作警告送信エラー: {str(e)}")

    def create_csv_from_diffs(self, update_request: Any) -> str:
        """Create a temporary CSV file from diff data and return path."""
        temp_file = tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".csv",
            delete=False,
            encoding="utf-8-sig",  # Excel friendly
        )
        csv_writer = csv.writer(temp_file)
        # カラム順序: アクション、銀行コード、支店コード、変更前情報、変更後情報、影響数
        csv_writer.writerow(
            [
                "アクション",
                "銀行コード",
                "支店コード",
                "変更前銀行名",
                "変更後銀行名",
                "変更前銀行名カナ",
                "変更後銀行名カナ",
                "変更前支店名",
                "変更後支店名",
                "変更前支店名カナ",
                "変更後支店名カナ",
                "影響アカウント数",
                "アクティブユーザー数",
            ]
        )
        
        # ソート: 影響アカウント数(降順) → アクティブユーザー数(降順) → 銀行コード(昇順)
        sorted_diffs = sorted(
            getattr(update_request, "diffs", []),
            key=lambda d: (
                -d.total_accounts,  # 影響アカウント数の降順
                -d.active_users,    # アクティブユーザー数の降順
                d.new_data.swift_code if d.new_data else d.old_data.swift_code if d.old_data else ""  # 銀行コードの昇順
            )
        )
        
        for diff in sorted_diffs:
            swift, branch = diff.key.split("-") if hasattr(diff, "key") else ("", "")
            
            # 新旧データから情報を取得
            bank_name = diff.new_data.bank_name if diff.new_data else ""
            bank_name_kana = diff.new_data.bank_name_kana if diff.new_data else ""
            branch_name = diff.new_data.branch_name if diff.new_data else ""
            branch_name_kana = diff.new_data.branch_name_kana if diff.new_data else ""
            old_bank_name = diff.old_data.bank_name if diff.old_data else ""
            old_bank_name_kana = diff.old_data.bank_name_kana if diff.old_data else ""
            old_branch_name = diff.old_data.branch_name if diff.old_data else ""
            old_branch_name_kana = diff.old_data.branch_name_kana if diff.old_data else ""
            
            # アクションによって表示を調整
            if diff.action == "delete":
                # 削除の場合は「変更後」を空欄にする
                bank_name = ""
                bank_name_kana = ""
                branch_name = ""
                branch_name_kana = ""
            
            csv_writer.writerow(
                [
                    diff.action,
                    swift,
                    branch,
                    old_bank_name,
                    bank_name,
                    old_bank_name_kana,
                    bank_name_kana,
                    old_branch_name,
                    branch_name,
                    old_branch_name_kana,
                    branch_name_kana,
                    diff.total_accounts,
                    diff.active_users,
                ]
            )
        temp_file.close()
        return temp_file.name

    def upload_csv_to_slack(
        self, file_path: str, message_ts: str = None, filename: str = None
    ) -> str:
        """Upload CSV file to Slack"""
        if self.client is None:
            return ""
        if not filename:
            filename = f"zengin_diff_{now_jst().strftime('%Y%m%d_%H%M%S')}.csv"
        try:
            response = self.client.files_upload_v2(
                channel=self.channel_id,
                file=file_path,
                filename=filename,
                title="全銀データ差分一覧",
                initial_comment="📄 全ての差分データをCSVファイルで出力しました。",
                thread_ts=message_ts,
            )
            logger.info(f"CSV uploaded to Slack: {filename}")
            return response["file"]["id"]
        except SlackApiError as e:
            logger.error(f"Slack CSV upload error: {str(e)}")
            return ""
        finally:
            try:
                os.unlink(file_path)
            except Exception:
                pass

    def send_csv_diff(self, update_request: Any, message_ts: str = None):
        """Create and upload CSV to Slack"""
        file_path = self.create_csv_from_diffs(update_request)
        return self.upload_csv_to_slack(file_path, message_ts)

    def send_csv_notification(self, csv_s3_url: str, filename: str, message_ts: str = None) -> str:
        """CSV出力完了通知をスレッドで送信"""
        if self.client is None:
            logger.info("Slack client unavailable – skip CSV notification")
            return ""
        
        notification_text = f"📄 *CSV出力完了*\n"
        notification_text += f"全ての差分データをCSVファイルで出力しました。\n"
        notification_text += f"*ファイル名*: {filename}\n"
        notification_text += f"*ダウンロード*: {csv_s3_url}\n"
        notification_text += f"*出力時刻*: {now_jst().strftime('%Y-%m-%d %H:%M:%S')} JST"
        
        try:
            response = self.client.chat_postMessage(
                channel=self.channel_id,
                text=notification_text,
                thread_ts=message_ts
            )
            logger.info("CSV出力通知送信完了")
            return response["ts"]
        except SlackApiError as e:
            logger.error(f"CSV出力通知送信エラー: {str(e)}")
            return ""
        except Exception as e:
            logger.error(f"CSV出力通知送信エラー: {str(e)}")
            return ""

    def send_completion_notification(self, result, diff_id: str, approved_by: str = None, message_ts: str = None) -> str:
        """処理完了通知をスレッドで送信"""
        if self.client is None:
            logger.info("Slack client unavailable – skip completion notification")
            return ""
        
        # 通知メッセージを構築
        if result.success:
            title = "🎉 全銀データ更新完了"
            status_emoji = "✅"
        else:
            title = "⚠️ 全銀データ更新エラー"
            status_emoji = "❌"
        
        message_text = f"{title}\n"
        message_text += f"*ステータス*: {status_emoji} {'成功' if result.success else 'エラー'}\n"
        message_text += f"*処理件数*: {result.processed_count}件\n"
        
        if result.error_count > 0:
            message_text += f"*エラー件数*: {result.error_count}件\n"
        
        if approved_by:
            message_text += f"*承認者*: {approved_by}\n"
        
        message_text += f"*実行時刻*: {now_jst().strftime('%Y-%m-%d %H:%M:%S')} JST\n"
        message_text += f"*詳細*: {result.details}"
        
        # エラー詳細を追加
        if hasattr(result, 'errors') and result.errors:
            message_text += f"\n\n*エラー詳細*:\n"
            for i, error in enumerate(result.errors[:5]):  # 最大5件まで表示
                message_text += f"{i+1}. {error}\n"
            if len(result.errors) > 5:
                message_text += f"...他 {len(result.errors) - 5}件のエラー"
        
        message_text += f"\n\n_Diff ID: {diff_id}_"
        
        # リトライ設定
        max_retries = int(os.getenv("SLACK_API_RETRY_COUNT", "3"))
        retry_delay = int(os.getenv("SLACK_API_RETRY_DELAY", "1000")) / 1000  # ミリ秒を秒に変換
        
        for retry in range(max_retries):
            try:
                response = self.client.chat_postMessage(
                    channel=self.channel_id,
                    text=message_text,
                    thread_ts=message_ts
                )
                logger.info("処理完了通知送信完了")
                return response["ts"]
            except SlackApiError as e:
                logger.error(f"処理完了通知送信エラー (リトライ {retry + 1}/{max_retries}): {str(e)}")
                if retry < max_retries - 1:
                    import time
                    time.sleep(retry_delay)
                else:
                    logger.error("最大リトライ回数に達しました。Slack通知を断念します。")
                    return ""
            except Exception as e:
                logger.error(f"処理完了通知送信エラー: {str(e)}")
                if retry < max_retries - 1:
                    import time
                    time.sleep(retry_delay)
                else:
                    logger.error("最大リトライ回数に達しました。Slack通知を断念します。")
                    return ""
        
        return ""
