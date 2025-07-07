import subprocess
import sys
import os
import json
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, Tuple
import time
import traceback

logger = logging.getLogger()

class ZenginCodeManager:
    """zengin-codeパッケージの動的管理クラス（Slack通知機能付き）"""
    
    def __init__(self, slack_client=None):
        self.cache_dir = "/tmp/.zengin_cache"
        self.cache_file = f"{self.cache_dir}/version_info.json"
        self.lib_dir = "/tmp/zengin_lib"
        self.slack_client = slack_client
        self.max_retries = 3
        self.retry_delay = 2  # 秒
        
    def _ensure_cache_dir(self):
        """キャッシュディレクトリを作成"""
        os.makedirs(self.cache_dir, exist_ok=True)
        os.makedirs(self.lib_dir, exist_ok=True)
        
    def _get_cached_version_info(self) -> Optional[Dict[str, Any]]:
        """キャッシュされたバージョン情報を取得"""
        if not os.path.exists(self.cache_file):
            return None
            
        try:
            with open(self.cache_file, 'r') as f:
                cache_data = json.load(f)
                
            # キャッシュの有効期限チェック（1時間）
            cached_time = datetime.fromisoformat(cache_data['timestamp'])
            if datetime.now() - cached_time > timedelta(hours=1):
                return None
                
            return cache_data
        except Exception as e:
            logger.warning(f"キャッシュ読み込みエラー: {str(e)}")
            return None
    
    def _save_cache(self, version: str, installed: bool):
        """バージョン情報をキャッシュ"""
        cache_data = {
            'version': version,
            'installed': installed,
            'timestamp': datetime.now().isoformat()
        }
        
        with open(self.cache_file, 'w') as f:
            json.dump(cache_data, f)
    
    def _get_latest_version(self) -> Tuple[Optional[str], Optional[str]]:
        """PyPIから最新バージョンを取得
        
        Returns:
            Tuple[Optional[str], Optional[str]]: (version, error_message)
        """
        for attempt in range(self.max_retries):
            try:
                result = subprocess.run(
                    [sys.executable, '-m', 'pip', 'index', 'versions', 'zengin-code'],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                
                if result.returncode == 0:
                    # 出力から最新バージョンを抽出
                    lines = result.stdout.strip().split('\n')
                    for line in lines:
                        if 'Available versions:' in line:
                            versions = line.split(':')[1].strip().split(', ')
                            return versions[0], None  # 最新バージョン
                    
                    # バージョンが見つからない場合
                    error_msg = "PyPIレスポンスからバージョン情報を取得できませんでした"
                    logger.warning(error_msg)
                    return None, error_msg
                else:
                    error_msg = f"pip index実行エラー: {result.stderr}"
                    if attempt < self.max_retries - 1:
                        logger.warning(f"{error_msg} (リトライ {attempt + 1}/{self.max_retries})")
                        time.sleep(self.retry_delay)
                        continue
                    return None, error_msg
                        
            except subprocess.TimeoutExpired:
                error_msg = "pip indexコマンドがタイムアウトしました"
                if attempt < self.max_retries - 1:
                    logger.warning(f"{error_msg} (リトライ {attempt + 1}/{self.max_retries})")
                    time.sleep(self.retry_delay)
                    continue
                return None, error_msg
            except Exception as e:
                error_msg = f"予期しないエラー: {str(e)}\n{traceback.format_exc()}"
                logger.error(error_msg)
                return None, error_msg
        
        return None, "最大リトライ回数を超えました"
    
    def _get_installed_version(self) -> Optional[str]:
        """現在インストールされているバージョンを取得"""
        try:
            import zengin_code
            return getattr(zengin_code, '__version__', None)
        except ImportError:
            return None
    
    def _notify_version_update(self, old_version: Optional[str], new_version: str):
        """バージョン更新をSlackに通知"""
        if not self.slack_client or old_version == new_version:
            return
            
        try:
            update_type = "新規インストール" if old_version is None else "更新"
            
            blocks = [
                {
                    "type": "header",
                    "text": {
                        "type": "plain_text",
                        "text": f"📦 zengin-codeライブラリ{update_type}",
                        "emoji": True
                    }
                },
                {
                    "type": "section",
                    "fields": [
                        {
                            "type": "mrkdwn",
                            "text": f"*旧バージョン:*\n{old_version or 'なし'}"
                        },
                        {
                            "type": "mrkdwn", 
                            "text": f"*新バージョン:*\n{new_version}"
                        }
                    ]
                },
                {
                    "type": "context",
                    "elements": [
                        {
                            "type": "mrkdwn",
                            "text": f"更新日時: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
                        }
                    ]
                }
            ]
            
            self.slack_client.post_message(
                text=f"zengin-codeライブラリを{new_version}に{update_type}しました",
                blocks=blocks
            )
            logger.info(f"バージョン更新通知を送信: {old_version} → {new_version}")
        except Exception as e:
            logger.error(f"バージョン更新通知の送信に失敗: {str(e)}")
            
    def _notify_update_failure(self, error_message: str, critical: bool = False):
        """更新失敗をSlackに通知"""
        if not self.slack_client:
            return
            
        try:
            severity = "⚠️ 警告" if not critical else "🚨 エラー"
            
            blocks = [
                {
                    "type": "header",
                    "text": {
                        "type": "plain_text",
                        "text": f"{severity}: zengin-codeライブラリ更新失敗",
                        "emoji": True
                    }
                },
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"zengin-codeライブラリの更新中にエラーが発生しました:\n```{error_message[:500]}```"
                    }
                },
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": "処理は既存のバージョンで継続されます。" if not critical else "Lambda関数の実行に失敗する可能性があります。"
                    }
                }
            ]
            
            self.slack_client.post_message(
                text=f"{severity}: zengin-codeライブラリの更新に失敗しました",
                blocks=blocks
            )
        except Exception as e:
            logger.error(f"エラー通知の送信に失敗: {str(e)}")

    def ensure_latest_version(self) -> Tuple[bool, Optional[str]]:
        """最新バージョンがインストールされていることを確認
        
        Returns:
            Tuple[bool, Optional[str]]: (success, error_message)
        """
        self._ensure_cache_dir()
        
        # キャッシュチェック
        cache_info = self._get_cached_version_info()
        if cache_info and cache_info['installed']:
            # 既にインストール済みの場合はスキップ
            logger.info(f"zengin-code {cache_info['version']} は既にインストール済み（キャッシュ）")
            return True, None
        
        # 現在のバージョンと最新バージョンを確認
        current_version = self._get_installed_version()
        latest_version, version_error = self._get_latest_version()
        
        if not latest_version:
            error_msg = f"最新バージョンの取得に失敗: {version_error}"
            logger.warning(error_msg)
            self._notify_update_failure(error_msg, critical=False)
            # 既存バージョンがあれば継続可能
            return current_version is not None, error_msg if current_version is None else None
        
        if current_version == latest_version:
            logger.info(f"zengin-code {current_version} は最新版です")
            self._save_cache(current_version, True)
            return True, None
        
        # 更新が必要な場合
        logger.info(f"zengin-codeを更新します: {current_version} → {latest_version}")
        
        # インストール試行（リトライ付き）
        for attempt in range(self.max_retries):
            try:
                # /tmpにインストール
                result = subprocess.run(
                    [
                        sys.executable, '-m', 'pip', 'install',
                        f'zengin-code=={latest_version}',
                        '--target', self.lib_dir,
                        '--upgrade',
                        '--no-deps'  # 依存関係は既にrequirements.txtで管理
                    ],
                    capture_output=True,
                    text=True,
                    timeout=60
                )
                
                if result.returncode != 0:
                    raise subprocess.CalledProcessError(result.returncode, result.args, result.stdout, result.stderr)
                
                # sys.pathに追加
                if self.lib_dir not in sys.path:
                    sys.path.insert(0, self.lib_dir)
                
                # インポートの再読み込み
                if 'zengin_code' in sys.modules:
                    del sys.modules['zengin_code']
                
                # インストール確認
                try:
                    import zengin_code
                    installed_version = getattr(zengin_code, '__version__', 'unknown')
                    if installed_version != latest_version:
                        raise ImportError(f"バージョン不一致: 期待={latest_version}, 実際={installed_version}")
                except ImportError as e:
                    raise RuntimeError(f"インストール後のインポートに失敗: {str(e)}")
                
                logger.info(f"zengin-code {latest_version} のインストールが完了しました")
                self._save_cache(latest_version, True)
                self._notify_version_update(current_version, latest_version)
                return True, None
                
            except subprocess.CalledProcessError as e:
                error_msg = f"pipインストールエラー (attempt {attempt + 1}/{self.max_retries}): {e.stderr}"
                logger.error(error_msg)
                if attempt < self.max_retries - 1:
                    time.sleep(self.retry_delay)
                    continue
                    
                self._notify_update_failure(error_msg, critical=current_version is None)
                return current_version is not None, error_msg
                
            except subprocess.TimeoutExpired:
                error_msg = f"インストールタイムアウト (attempt {attempt + 1}/{self.max_retries})"
                logger.error(error_msg)
                if attempt < self.max_retries - 1:
                    time.sleep(self.retry_delay)
                    continue
                    
                self._notify_update_failure(error_msg, critical=current_version is None)
                return current_version is not None, error_msg
                
            except Exception as e:
                error_msg = f"予期しないエラー: {str(e)}\n{traceback.format_exc()}"
                logger.error(error_msg)
                self._notify_update_failure(error_msg, critical=current_version is None)
                return current_version is not None, error_msg
        
        # 全リトライ失敗
        error_msg = "最大リトライ回数を超えました"
        self._notify_update_failure(error_msg, critical=current_version is None)
        return current_version is not None, error_msg