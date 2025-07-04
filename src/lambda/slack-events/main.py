import json
import logging
import os
from typing import Any, Dict
import boto3
from botocore.exceptions import ClientError
from common.monitoring_utils import lambda_handler_wrapper, performance_timer

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

@lambda_handler_wrapper('slack-events')
def handler(event: Dict[str, Any], context: Any, logger, metrics) -> Dict[str, Any]:
    """Lambda function main handler for Slack Events API"""
    try:
        logger.info("Received Slack events", event_data=event)
        
        # Parse the API Gateway event
        if 'body' not in event:
            logger.error("No body in event")
            return create_response(400, {"error": "Invalid request format"})
        
        # Parse the request body
        if isinstance(event['body'], str):
            try:
                body = json.loads(event['body'])
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON body: {e}")
                return create_response(400, {"error": "Invalid JSON format"})
        else:
            body = event['body']
        
        # Handle URL verification challenge
        if body.get('type') == 'url_verification':
            challenge = body.get('challenge')
            if challenge:
                logger.info("Slack URL verification challenge received")
                return create_response(200, {"challenge": challenge})
            else:
                logger.error("URL verification challenge missing challenge field")
                return create_response(400, {"error": "Missing challenge"})
        
        # Handle Slack events
        if body.get('type') == 'event_callback':
            return handle_event_callback(body)
        
        # Handle other event types or unknown events
        logger.warning(f"Unhandled event type: {body.get('type')}")
        return create_response(200, {"status": "ok"})
        
    except Exception as e:
        logger.error(f"Slack events handler error: {str(e)}")
        return create_response(500, {"error": "Internal server error"})


def handle_event_callback(body: Dict[str, Any]) -> Dict[str, Any]:
    """Handle Slack event callback"""
    try:
        event_data = body.get('event', {})
        event_type = event_data.get('type')
        
        logger.info(f"Processing event callback: {event_type}")
        
        # Handle app mentions
        if event_type == 'app_mention':
            return handle_app_mention(event_data)
        
        # Handle direct messages
        elif event_type == 'message':
            return handle_message(event_data)
        
        # Handle other event types
        else:
            logger.info(f"Unhandled event type: {event_type}")
            return create_response(200, {"status": "ok"})
            
    except Exception as e:
        logger.error(f"Event callback handler error: {str(e)}")
        return create_response(500, {"error": "Event processing failed"})


def handle_app_mention(event_data: Dict[str, Any]) -> Dict[str, Any]:
    """Handle app mention events"""
    try:
        user = event_data.get('user')
        text = event_data.get('text', '')
        channel = event_data.get('channel')
        ts = event_data.get('ts')
        
        logger.info(f"App mention from user {user} in channel {channel}: {text}")
        
        # Process mentions if needed
        # For now, just acknowledge the mention
        
        return create_response(200, {"status": "mention_processed"})
        
    except Exception as e:
        logger.error(f"App mention handler error: {str(e)}")
        return create_response(500, {"error": "Mention processing failed"})


def handle_message(event_data: Dict[str, Any]) -> Dict[str, Any]:
    """Handle direct message events"""
    try:
        # Skip bot messages and messages without text
        if event_data.get('bot_id') or not event_data.get('text'):
            return create_response(200, {"status": "ignored"})
        
        user = event_data.get('user')
        text = event_data.get('text', '')
        channel = event_data.get('channel')
        ts = event_data.get('ts')
        
        logger.info(f"Direct message from user {user} in channel {channel}: {text}")
        
        # Process direct messages if needed
        # For now, just acknowledge the message
        
        return create_response(200, {"status": "message_processed"})
        
    except Exception as e:
        logger.error(f"Message handler error: {str(e)}")
        return create_response(500, {"error": "Message processing failed"})


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
    """Validate Slack request signature"""
    try:
        import hmac
        import hashlib
        import time
        
        # Get signature validation secret from environment
        signing_secret = os.environ.get('SLACK_SIGNING_SECRET')
        if not signing_secret:
            logger.warning("SLACK_SIGNING_SECRET not configured")
            return True  # Skip validation if secret not configured
        
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