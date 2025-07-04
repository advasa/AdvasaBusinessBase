"""
AWS SDK configuration for VPC endpoint usage
"""
import os
import boto3
from botocore.config import Config

# VPCエンドポイントのDNS名（環境変数から取得）
CLOUDWATCH_LOGS_ENDPOINT = os.getenv('CLOUDWATCH_LOGS_ENDPOINT')
CLOUDWATCH_ENDPOINT = os.getenv('CLOUDWATCH_ENDPOINT')

# カスタム設定
custom_config = Config(
    region_name='ap-northeast-1',
    retries={
        'max_attempts': 3,
        'mode': 'adaptive'
    },
    connect_timeout=5,
    read_timeout=10
)

def get_cloudwatch_logs_client():
    """CloudWatch Logs クライアントを取得"""
    if CLOUDWATCH_LOGS_ENDPOINT:
        return boto3.client(
            'logs',
            endpoint_url=f'https://{CLOUDWATCH_LOGS_ENDPOINT}',
            config=custom_config
        )
    return boto3.client('logs', config=custom_config)

def get_cloudwatch_client():
    """CloudWatch クライアントを取得"""
    if CLOUDWATCH_ENDPOINT:
        return boto3.client(
            'cloudwatch',
            endpoint_url=f'https://{CLOUDWATCH_ENDPOINT}',
            config=custom_config
        )
    return boto3.client('cloudwatch', config=custom_config)