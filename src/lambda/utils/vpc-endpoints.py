"""VPCエンドポイント情報をSecrets Managerから取得するユーティリティ"""

import os
import json
import boto3
from typing import Dict, Optional
from botocore.exceptions import ClientError


class VPCEndpointsManager:
    """VPCエンドポイント情報の管理クラス"""
    
    def __init__(self):
        self.secrets_client = boto3.client('secretsmanager')
        self.secret_arn = os.environ.get('VPC_ENDPOINTS_SECRET_ARN')
        self._endpoints_cache: Optional[Dict[str, str]] = None
    
    def get_endpoints(self) -> Dict[str, str]:
        """VPCエンドポイント情報を取得（キャッシュ付き）"""
        if self._endpoints_cache:
            return self._endpoints_cache
        
        if not self.secret_arn:
            # Secrets Managerが設定されていない場合は空の辞書を返す
            return {}
        
        try:
            response = self.secrets_client.get_secret_value(
                SecretId=self.secret_arn
            )
            
            secret_data = json.loads(response['SecretString'])
            self._endpoints_cache = secret_data
            return secret_data
            
        except ClientError as e:
            print(f"Error retrieving VPC endpoints from Secrets Manager: {e}")
            return {}
        except json.JSONDecodeError as e:
            print(f"Error parsing VPC endpoints JSON: {e}")
            return {}
    
    def get_cloudwatch_logs_endpoint(self) -> Optional[str]:
        """CloudWatch Logsエンドポイントを取得"""
        endpoints = self.get_endpoints()
        return endpoints.get('cloudwatchLogsEndpoint')
    
    def get_cloudwatch_monitoring_endpoint(self) -> Optional[str]:
        """CloudWatch Monitoringエンドポイントを取得"""
        endpoints = self.get_endpoints()
        return endpoints.get('cloudwatchMonitoringEndpoint')
    
    def get_secrets_manager_endpoint(self) -> Optional[str]:
        """Secrets Managerエンドポイントを取得"""
        endpoints = self.get_endpoints()
        return endpoints.get('secretsManagerEndpoint')
    
    def get_eventbridge_endpoint(self) -> Optional[str]:
        """EventBridgeエンドポイントを取得"""
        endpoints = self.get_endpoints()
        return endpoints.get('eventBridgeEndpoint')
    
    def get_eventbridge_scheduler_endpoint(self) -> Optional[str]:
        """EventBridge Schedulerエンドポイントを取得"""
        endpoints = self.get_endpoints()
        return endpoints.get('eventBridgeSchedulerEndpoint')
    
    def get_lambda_endpoint(self) -> Optional[str]:
        """Lambdaエンドポイントを取得"""
        endpoints = self.get_endpoints()
        return endpoints.get('lambdaEndpoint')
    
    def configure_boto3_client(self, service_name: str, **kwargs) -> boto3.client:
        """VPCエンドポイントを使用してboto3クライアントを設定"""
        endpoint_mapping = {
            'logs': self.get_cloudwatch_logs_endpoint,
            'cloudwatch': self.get_cloudwatch_monitoring_endpoint,
            'secretsmanager': self.get_secrets_manager_endpoint,
            'events': self.get_eventbridge_endpoint,
            'scheduler': self.get_eventbridge_scheduler_endpoint,
            'lambda': self.get_lambda_endpoint,
        }
        
        # エンドポイントURLを取得
        endpoint_url = None
        if service_name in endpoint_mapping:
            endpoint_getter = endpoint_mapping[service_name]
            endpoint = endpoint_getter()
            if endpoint:
                endpoint_url = f"https://{endpoint}"
        
        # クライアント設定
        client_config = kwargs.copy()
        if endpoint_url:
            client_config['endpoint_url'] = endpoint_url
        
        return boto3.client(service_name, **client_config)


# シングルトンインスタンス
vpc_endpoints_manager = VPCEndpointsManager()


def get_configured_client(service_name: str, **kwargs) -> boto3.client:
    """VPCエンドポイントを考慮したboto3クライアントを取得
    
    Args:
        service_name: AWSサービス名 (例: 'logs', 'cloudwatch', 'secretsmanager')
        **kwargs: その他のboto3クライアント設定
    
    Returns:
        設定済みのboto3クライアント
    """
    return vpc_endpoints_manager.configure_boto3_client(service_name, **kwargs)


def get_endpoints_info() -> Dict[str, str]:
    """すべてのVPCエンドポイント情報を取得
    
    Returns:
        VPCエンドポイント情報の辞書
    """
    return vpc_endpoints_manager.get_endpoints()