import json
import logging
import os
from typing import Any, Dict, List
from urllib.parse import parse_qs
from datetime import datetime
import boto3
from botocore.exceptions import ClientError

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Lambda function main handler for Slack Interactive Components"""
    try:
        logger.info(f"Received Slack interactive event: {json.dumps(event, ensure_ascii=False)}")
        
        # Parse the API Gateway event
        if 'body' not in event:
            logger.error("No body in event")
            return create_response(400, {"error": "Invalid request format"})
        
        # Validate Slack signature
        if not validate_slack_signature(event):
            logger.error("Invalid Slack signature")
            log_security_event('signature_validation_failed', {}, 'rejected', event)
            return create_response(401, {"error": "Unauthorized"})
        
        # Parse the request body (form-encoded)
        body = event['body']
        if isinstance(body, str):
            # Parse form-encoded data
            parsed_data = parse_qs(body)
            payload_str = parsed_data.get('payload', [''])[0]
            
            if not payload_str:
                logger.error("No payload in request")
                return create_response(400, {"error": "Missing payload"})
            
            try:
                payload = json.loads(payload_str)
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON payload: {e}")
                return create_response(400, {"error": "Invalid JSON format"})
        else:
            logger.error("Unexpected body format")
            return create_response(400, {"error": "Invalid body format"})
        
        # Validate team ID
        if not validate_slack_team(payload):
            logger.error("Unauthorized team ID")
            log_security_event('team_validation_failed', payload, 'rejected', event)
            return create_response(403, {"error": "Forbidden"})
        
        # Get interaction type
        interaction_type = payload.get('type')
        
        logger.info(f"Processing interaction type: {interaction_type}")

        # Route to appropriate handler based on interaction type
        if interaction_type == 'block_actions':
            # Handle block actions (button clicks) and invoke callback handler
            logger.info("Processing block_actions interaction")
            
            # ユーザー権限の検証
            user = payload.get('user', {})
            actions = payload.get('actions', [])
            
            # デバッグ用：受信したペイロードを詳細にログ出力
            logger.info(f"Received payload type: {payload.get('type')}")
            logger.info(f"Number of actions: {len(actions)}")
            logger.info(f"Actions data: {json.dumps(actions, ensure_ascii=False)}")
            
            # 最初のアクションに対して権限チェック
            if actions:
                action_id = actions[0].get('action_id')
                logger.info(f"Processing action_id: {action_id}")
                logger.info(f"Action value: {actions[0].get('value')}")
                
                if not validate_user_permissions(user, action_id):
                    log_security_event('user_permission_denied', payload, 'rejected', event)
                    return create_response(403, {"error": "You don't have permission to perform this action"})
                
                # 成功した場合、監査ログを記録
                logger.info(f"User {user.get('id')} authorized, logging security event")
                log_security_event('block_action_authenticated', payload, 'success', event)
                
                # 重要なアクションの場合は追加の監査ログを記録
                logger.info(f"Checking if action is critical: {action_id}")
                if is_critical_action(action_id):
                    logger.info(f"Critical action detected: {action_id}")
                    # アクション固有のイベントとして記録
                    log_security_event(action_id, payload, 'success', event)
                else:
                    logger.info(f"Action {action_id} is not critical")
            
            # 1) Immediately invoke downstream processing Lambda **asynchronously** so we can respond within 3 seconds.
            #    We pass the entire Slack payload and the interaction type so that the downstream
            #    function can perform the heavy-weight logic (updating / replacing messages, etc.).
            invoke_callback_handler({
                "interaction_type": interaction_type,
                "payload": payload,
            })
            
            # 2) Return an empty body to Slack to acknowledge the request promptly. An empty JSON
            #    object (or even an empty string) is perfectly acceptable and results in no UI changes
            #    on Slack; the subsequent asynchronous job will update the message layout using
            #    `response_url` or chat.update as necessary.
            return create_response(200, {})
            
        elif interaction_type == 'view_submission':
            return handle_view_submission(payload)
        elif interaction_type == 'view_closed':
            return handle_view_closed(payload)
        elif interaction_type == 'shortcut':
            return handle_shortcut(payload)
        else:
            logger.warning(f"Unhandled interaction type: {interaction_type}")
            return create_response(200, {"text": "Interaction type not supported"})
        
    except Exception as e:
        logger.error(f"Slack interactive handler error: {str(e)}")
        return create_response(500, {"error": "Internal server error"})


def handle_block_actions(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Handle block action interactions (button clicks, etc.)"""
    try:
        user = payload.get('user', {})
        actions = payload.get('actions', [])
        message = payload.get('message', {})
        response_url = payload.get('response_url')
        
        logger.info(f"Block actions from user {user.get('name')}: {len(actions)} actions")
        
        # Log successful authentication
        log_security_event('block_action_authenticated', payload, 'success', None)
        
        for action in actions:
            action_id = action.get('action_id')
            action_value = action.get('value')
            
            logger.info(f"Processing action: {action_id} with value: {action_value}")
            
            # Validate user permissions for this action
            if not validate_user_permissions(user, action_id):
                log_security_event('user_permission_denied', payload, 'rejected', None)
                return create_response(403, {"error": "You don't have permission to perform this action"})
            
            # Route to specific action handlers
            if action_id == 'approve_update':
                return handle_approve_action(payload, action)
            elif action_id == 'reject_update':
                return handle_reject_action(payload, action)
            elif action_id == 'approve_immediate':
                return handle_immediate_action(payload, action)
            elif action_id in ['approve_1h', 'approve_3h', 'approve_5h']:
                return handle_custom_time_action(payload, action)
            elif action_id == 'export_csv':
                return handle_csv_export_action(payload, action)
            else:
                logger.warning(f"Unhandled action: {action_id}")
        
        return create_response(200, {"text": "Action processed"})
        
    except Exception as e:
        logger.error(f"Block actions handler error: {str(e)}")
        return create_response(500, {"error": "Action processing failed"})


def handle_approve_action(payload: Dict[str, Any], action: Dict[str, Any]) -> Dict[str, Any]:
    """Handle approval button clicks"""
    try:
        user = payload.get('user', {})
        message = payload.get('message', {})
        message_ts = message.get('ts')
        
        logger.info(f"Approval action from user {user.get('name')} for message {message_ts}")
        
        # Send to zengin-callback-handler Lambda for processing
        response = invoke_callback_handler({
            'type': 'approve_update',
            'user': user,
            'message_ts': message_ts,
            'action_value': action.get('value', '{}')
        })
        
        # Return immediate response to avoid timeout
        return create_response(200, {
            "response_type": "in_channel",
            "text": f"承認処理を開始しました。処理完了まで少々お待ちください..."
        })
        
    except Exception as e:
        logger.error(f"Approve action handler error: {str(e)}")
        return create_response(500, {"error": "Approval processing failed"})


def handle_reject_action(payload: Dict[str, Any], action: Dict[str, Any]) -> Dict[str, Any]:
    """Handle rejection button clicks"""
    try:
        user = payload.get('user', {})
        message = payload.get('message', {})
        message_ts = message.get('ts')
        
        logger.info(f"Rejection action from user {user.get('name')} for message {message_ts}")
        
        # Send to zengin-callback-handler Lambda for processing
        response = invoke_callback_handler({
            'type': 'reject_update',
            'user': user,
            'message_ts': message_ts
        })
        
        # Return immediate response
        return create_response(200, {
            "response_type": "in_channel",
            "text": f"却下処理を開始しました。"
        })
        
    except Exception as e:
        logger.error(f"Reject action handler error: {str(e)}")
        return create_response(500, {"error": "Rejection processing failed"})


def handle_immediate_action(payload: Dict[str, Any], action: Dict[str, Any]) -> Dict[str, Any]:
    """Handle immediate execution button clicks"""
    try:
        user = payload.get('user', {})
        message = payload.get('message', {})
        message_ts = message.get('ts')
        
        logger.info(f"Immediate execution action from user {user.get('name')} for message {message_ts}")
        
        # Send to zengin-callback-handler Lambda for processing
        response = invoke_callback_handler({
            'type': 'approve_immediate',
            'user': user,
            'message_ts': message_ts,
            'action_value': action.get('value', '{}')
        })
        
        return create_response(200, {
            "response_type": "in_channel",
            "text": f"即時実行処理を開始しました。"
        })
        
    except Exception as e:
        logger.error(f"Immediate action handler error: {str(e)}")
        return create_response(500, {"error": "Immediate execution failed"})


def handle_custom_time_action(payload: Dict[str, Any], action: Dict[str, Any]) -> Dict[str, Any]:
    """Handle custom time execution button clicks"""
    try:
        user = payload.get('user', {})
        message = payload.get('message', {})
        message_ts = message.get('ts')
        action_id = action.get('action_id')
        
        # Extract hours from action_id
        hours_map = {
            'approve_1h': 1,
            'approve_3h': 3,
            'approve_5h': 5
        }
        hours = hours_map.get(action_id, 1)
        
        logger.info(f"Custom time ({hours}h) action from user {user.get('name')} for message {message_ts}")
        
        # Send to zengin-callback-handler Lambda for processing
        response = invoke_callback_handler({
            'type': action_id,
            'user': user,
            'message_ts': message_ts,
            'hours': hours
        })
        
        return create_response(200, {
            "response_type": "in_channel",
            "text": f"{hours}時間後実行処理を開始しました。"
        })
        
    except Exception as e:
        logger.error(f"Custom time action handler error: {str(e)}")
        return create_response(500, {"error": "Custom time execution failed"})


def handle_csv_export_action(payload: Dict[str, Any], action: Dict[str, Any]) -> Dict[str, Any]:
    """Handle CSV export button clicks"""
    try:
        user = payload.get('user', {})
        message = payload.get('message', {})
        message_ts = message.get('ts')
        
        logger.info(f"CSV export action from user {user.get('name')} for message {message_ts}")
        
        # Send to zengin-callback-handler Lambda for processing
        response = invoke_callback_handler({
            'type': 'export_csv',
            'user': user,
            'message_ts': message_ts
        })
        
        return create_response(200, {
            "response_type": "ephemeral",
            "text": "CSV出力を開始しています..."
        })
        
    except Exception as e:
        logger.error(f"CSV export action handler error: {str(e)}")
        return create_response(500, {"error": "CSV export failed"})


def handle_view_submission(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Handle modal view submissions"""
    try:
        user = payload.get('user', {})
        view = payload.get('view', {})
        
        logger.info(f"View submission from user {user.get('name')}")
        
        # Process modal submissions if needed
        return create_response(200, {"response_action": "clear"})
        
    except Exception as e:
        logger.error(f"View submission handler error: {str(e)}")
        return create_response(500, {"error": "View submission failed"})


def handle_view_closed(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Handle modal view closures"""
    try:
        user = payload.get('user', {})
        view = payload.get('view', {})
        
        logger.info(f"View closed by user {user.get('name')}")
        
        return create_response(200, {"status": "ok"})
        
    except Exception as e:
        logger.error(f"View closed handler error: {str(e)}")
        return create_response(500, {"error": "View closure failed"})


def handle_shortcut(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Handle shortcut interactions"""
    try:
        user = payload.get('user', {})
        callback_id = payload.get('callback_id')
        
        logger.info(f"Shortcut {callback_id} from user {user.get('name')}")
        
        # Process shortcuts if needed
        return create_response(200, {"text": "Shortcut processed"})
        
    except Exception as e:
        logger.error(f"Shortcut handler error: {str(e)}")
        return create_response(500, {"error": "Shortcut processing failed"})


def invoke_callback_handler(event_data: Dict[str, Any]) -> Dict[str, Any]:
    """Invoke the zengin-callback-handler Lambda function"""
    try:
        lambda_client = boto3.client('lambda')
        callback_function_name = os.environ.get('CALLBACK_HANDLER_FUNCTION_NAME')
        
        logger.info(f"Attempting to invoke callback handler: {callback_function_name}")
        
        if not callback_function_name:
            logger.error("CALLBACK_HANDLER_FUNCTION_NAME not configured")
            return {"error": "Configuration error"}
        
        logger.info(f"Invoking callback handler with payload: {json.dumps(event_data, ensure_ascii=False)}")
        
        # Invoke the callback handler asynchronously
        response = lambda_client.invoke(
            FunctionName=callback_function_name,
            InvocationType='Event',  # Async invocation
            Payload=json.dumps(event_data, ensure_ascii=False)
        )
        
        logger.info(f"Successfully invoked callback handler. Response: StatusCode={response.get('StatusCode')}, Payload={response.get('Payload')}")
        return {"status": "invoked"}
        
    except Exception as e:
        logger.error(f"Failed to invoke callback handler: {str(e)}")
        return {"error": str(e)}


def create_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    """Create API Gateway response"""
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Slack-Request-Timestamp,X-Slack-Signature',
            'Access-Control-Allow-Methods': 'POST,OPTIONS'
        },
        'body': json.dumps(body, ensure_ascii=False)
    }


def validate_slack_signature(event: Dict[str, Any]) -> bool:
    """Validate Slack request signature - STRICT MODE"""
    try:
        import hmac
        import hashlib
        import time
        
        # Get signing secret from Secrets Manager
        signing_secret = get_slack_signing_secret()
        if not signing_secret:
            logger.error("CRITICAL: Slack signing secret not available - rejecting request")
            return False  # ALWAYS REJECT if secret not available
        
        # Get headers
        headers = event.get('headers', {})
        timestamp = headers.get('X-Slack-Request-Timestamp', headers.get('x-slack-request-timestamp'))
        signature = headers.get('X-Slack-Signature', headers.get('x-slack-signature'))
        
        if not timestamp or not signature:
            logger.error("Missing Slack signature headers")
            return False
        
        # Check timestamp (prevent replay attacks)
        current_time = int(time.time())
        if abs(current_time - int(timestamp)) > 300:  # 5 minutes
            logger.error("Request timestamp too old")
            return False
        
        # Verify signature
        body = event.get('body', '')
        sig_basestring = f"v0:{timestamp}:{body}"
        expected_signature = 'v0=' + hmac.new(
            signing_secret.encode(),
            sig_basestring.encode(),
            hashlib.sha256
        ).hexdigest()
        
        if not hmac.compare_digest(expected_signature, signature):
            logger.error("Invalid Slack signature")
            return False
        
        return True
        
    except Exception as e:
        logger.error(f"Signature validation error: {str(e)}")
        return False


def get_slack_signing_secret() -> str:
    """Get Slack signing secret from Secrets Manager"""
    try:
        secret_arn = os.environ.get('SLACK_SIGN_SECRET_ARN')
        if not secret_arn:
            logger.warning("SLACK_SIGN_SECRET_ARN not configured")
            return ""
        
        logger.info(f"Attempting to get secret from: {secret_arn}")
        
        # VPC内からのアクセスのため、リージョンを明示的に指定
        secrets_client = boto3.client(
            'secretsmanager',
            region_name='ap-northeast-1'
        )
        response = secrets_client.get_secret_value(SecretId=secret_arn)
        
        secret_value = response.get('SecretString', '')
        if secret_value:
            # Parse JSON if needed
            try:
                secret_data = json.loads(secret_value)
                # Try both key names for compatibility
                signing_secret = secret_data.get('signingSecret') or secret_data.get('signing_secret', '')
                if signing_secret:
                    logger.info("Successfully retrieved Slack signing secret")
                    return signing_secret
                else:
                    logger.error(f"No signing secret found in secret data. Keys: {list(secret_data.keys())}")
                    return ""
            except json.JSONDecodeError:
                # Assume plain text secret
                logger.info("Using plain text secret")
                return secret_value
        
        logger.error("No SecretString in response")
        return ""
        
    except Exception as e:
        logger.error(f"Failed to get Slack signing secret: {str(e)}")
        return ""


def validate_slack_team(payload: Dict[str, Any]) -> bool:
    """Validate that request comes from authorized Slack workspace"""
    allowed_team_ids = os.environ.get('ALLOWED_SLACK_TEAM_IDS', '').split(',')
    team_id = payload.get('team', {}).get('id')
    
    if not allowed_team_ids or not allowed_team_ids[0]:
        logger.warning("No allowed team IDs configured - skipping team validation")
        return True
    
    if team_id not in allowed_team_ids:
        logger.error(f"Unauthorized team ID: {team_id}")
        return False
    
    return True


def validate_user_permissions(user: Dict[str, Any], action: str) -> bool:
    """Validate user has permission for the requested action"""
    user_id = user.get('id')
    authorized_users_str = os.environ.get('AUTHORIZED_USER_IDS', '')
    
    if not authorized_users_str:
        logger.warning("No authorized users configured - allowing all users")
        return True
    
    # splitした結果から空文字列を除外
    authorized_users = [uid.strip() for uid in authorized_users_str.split(',') if uid.strip()]
    
    if not authorized_users:
        logger.warning("No valid authorized users after parsing - allowing all users")
        return True
    
    if user_id not in authorized_users:
        logger.error(f"Unauthorized user: '{user_id}' not in {authorized_users} for action: {action}")
        return False
    return True


def log_security_event(event_type: str, payload: Dict[str, Any], result: str, api_event: Dict[str, Any] = None) -> None:
    """Log security-related events for audit"""
    try:
        # Extract IP address from API Gateway event
        ip_address = None
        if api_event:
            headers = api_event.get('headers', {})
            ip_address = headers.get('X-Forwarded-For', headers.get('x-forwarded-for', ''))
            if ip_address:
                ip_address = ip_address.split(',')[0].strip()
        
        security_log = {
            'timestamp': datetime.utcnow().isoformat(),
            'event_type': event_type,
            'user_id': payload.get('user', {}).get('id') if payload else None,
            'user_name': payload.get('user', {}).get('name') if payload else None,
            'team_id': payload.get('team', {}).get('id') if payload else None,
            'team_domain': payload.get('team', {}).get('domain') if payload else None,
            'action': payload.get('actions', [{}])[0].get('action_id') if payload and payload.get('actions') else None,
            'result': result,
            'ip_address': ip_address,
        }
        
        # CloudWatch Logsに記録（構造化ログとして出力）
        logger.info(f"SECURITY_AUDIT: {json.dumps(security_log, ensure_ascii=False)}")
        
        # 重要なアクションはDynamoDBにも保存
        action = security_log.get('action') or event_type
        logger.info(f"Checking if should save to DynamoDB - action: {action}, event_type: {event_type}")
        
        # event_typeが直接critical actionの場合も考慮
        if is_critical_action(action) or is_critical_action(event_type):
            logger.info(f"Saving critical action to DynamoDB: {action or event_type}")
            save_to_audit_table(security_log)
        else:
            logger.info(f"Action {action or event_type} is not critical, not saving to DynamoDB")
            
    except Exception as e:
        logger.error(f"Failed to log security event: {str(e)}")


def is_critical_action(action: str) -> bool:
    """Determine if an action is critical and should be persisted"""
    critical_actions = ['approve_update', 'approve_immediate', 'reject_update', 'approve_1h', 'approve_3h', 'approve_5h']
    return action in critical_actions if action else False


def save_to_audit_table(security_log: Dict[str, Any]) -> None:
    """Save security audit log to DynamoDB"""
    try:
        table_name = os.environ.get('AUDIT_TABLE_NAME')
        if not table_name:
            logger.warning("Audit table name not configured")
            return
        
        logger.info(f"Attempting to save audit log to table: {table_name}")
        logger.info(f"Security log data: {json.dumps(security_log, ensure_ascii=False)}")
        
        # リージョンを明示的に指定
        dynamodb = boto3.resource('dynamodb', region_name='ap-northeast-1')
        table = dynamodb.Table(table_name)
        
        # Add unique ID and TTL
        security_log['id'] = f"{security_log['timestamp']}#{security_log.get('user_id', 'unknown')}"
        security_log['ttl'] = int((datetime.utcnow().timestamp())) + (90 * 24 * 60 * 60)  # 90 days TTL
        
        logger.info(f"Saving item with ID: {security_log['id']}, TTL: {security_log['ttl']}")
        
        table.put_item(Item=security_log)
        logger.info(f"Security audit log saved to DynamoDB: {security_log['id']}")
        
    except ClientError as e:
        logger.error(f"DynamoDB ClientError: {e.response['Error']['Code']} - {e.response['Error']['Message']}")
        logger.error(f"Request data: {json.dumps(security_log, ensure_ascii=False)}")
    except Exception as e:
        logger.error(f"Failed to save audit log to DynamoDB: {str(e)}")
        logger.error(f"Error type: {type(e).__name__}")