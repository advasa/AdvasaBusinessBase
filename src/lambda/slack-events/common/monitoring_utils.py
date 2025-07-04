import json
import logging
import time
import uuid
from datetime import datetime
from typing import Dict, Any, Optional
import boto3
from contextlib import contextmanager

# CloudWatch client for custom metrics
cloudwatch = boto3.client('cloudwatch')

class StructuredLogger:
    """
    Structured logger for Lambda functions that provides consistent logging format
    and automatic correlation ID tracking.
    """
    
    def __init__(self, service_name: str, log_level: str = 'INFO'):
        self.service_name = service_name
        self.logger = logging.getLogger(service_name)
        self.logger.setLevel(getattr(logging, log_level.upper()))
        
        # Configure structured logging format
        if not self.logger.handlers:
            handler = logging.StreamHandler()
            formatter = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
            )
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)
    
    def _format_log(self, level: str, message: str, **kwargs) -> Dict[str, Any]:
        """Format log entry as structured JSON"""
        log_entry = {
            'timestamp': datetime.utcnow().isoformat(),
            'service': self.service_name,
            'level': level,
            'message': message,
            **kwargs
        }
        
        # Add correlation ID if available
        correlation_id = getattr(self, '_correlation_id', None)
        if correlation_id:
            log_entry['correlation_id'] = correlation_id
            
        return log_entry
    
    def set_correlation_id(self, correlation_id: str):
        """Set correlation ID for tracking requests across services"""
        self._correlation_id = correlation_id
    
    def info(self, message: str, **kwargs):
        log_entry = self._format_log('INFO', message, **kwargs)
        self.logger.info(json.dumps(log_entry))
    
    def error(self, message: str, **kwargs):
        log_entry = self._format_log('ERROR', message, **kwargs)
        self.logger.error(json.dumps(log_entry))
    
    def warning(self, message: str, **kwargs):
        log_entry = self._format_log('WARNING', message, **kwargs)
        self.logger.warning(json.dumps(log_entry))
    
    def debug(self, message: str, **kwargs):
        log_entry = self._format_log('DEBUG', message, **kwargs)
        self.logger.debug(json.dumps(log_entry))

class MetricsEmitter:
    """
    Helper class for emitting custom CloudWatch metrics from Lambda functions.
    """
    
    def __init__(self, namespace: str, environment: str, service_name: str):
        self.namespace = namespace
        self.environment = environment
        self.service_name = service_name
        self.default_dimensions = {
            'Environment': environment,
            'Service': service_name
        }
    
    def emit_count_metric(self, metric_name: str, value: int = 1, dimensions: Optional[Dict[str, str]] = None):
        """Emit a count metric"""
        self._emit_metric(metric_name, value, 'Count', dimensions)
    
    def emit_duration_metric(self, metric_name: str, duration_ms: float, dimensions: Optional[Dict[str, str]] = None):
        """Emit a duration metric in milliseconds"""
        self._emit_metric(metric_name, duration_ms, 'Milliseconds', dimensions)
    
    def emit_business_metric(self, event_type: str, count: int = 1, dimensions: Optional[Dict[str, str]] = None):
        """Emit business-specific metrics"""
        metric_name = f"Business.{event_type}"
        self._emit_metric(metric_name, count, 'Count', dimensions)
    
    def emit_error_metric(self, error_type: str, dimensions: Optional[Dict[str, str]] = None):
        """Emit error metrics"""
        error_dimensions = {'ErrorType': error_type}
        if dimensions:
            error_dimensions.update(dimensions)
        self._emit_metric('Errors', 1, 'Count', error_dimensions)
    
    def _emit_metric(self, metric_name: str, value: float, unit: str, dimensions: Optional[Dict[str, str]] = None):
        """Internal method to emit metrics to CloudWatch"""
        try:
            metric_dimensions = self.default_dimensions.copy()
            if dimensions:
                metric_dimensions.update(dimensions)
            
            cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[
                    {
                        'MetricName': metric_name,
                        'Value': value,
                        'Unit': unit,
                        'Dimensions': [
                            {'Name': k, 'Value': v} for k, v in metric_dimensions.items()
                        ],
                        'Timestamp': datetime.utcnow()
                    }
                ]
            )
        except Exception as e:
            # Log error but don't fail the function
            print(f"Failed to emit metric {metric_name}: {str(e)}")

@contextmanager
def performance_timer(logger: StructuredLogger, metrics: MetricsEmitter, operation_name: str):
    """
    Context manager for timing operations and automatically emitting performance metrics.
    
    Usage:
    with performance_timer(logger, metrics, 'database_query'):
        # Your code here
        result = database.query()
    """
    start_time = time.time()
    success = True
    error_type = None
    
    try:
        logger.debug(f"Starting operation: {operation_name}")
        yield
    except Exception as e:
        success = False
        error_type = type(e).__name__
        logger.error(f"Operation failed: {operation_name}", error=str(e), error_type=error_type)
        metrics.emit_error_metric(error_type, {'Operation': operation_name})
        raise
    finally:
        duration_ms = (time.time() - start_time) * 1000
        status = 'Success' if success else 'Error'
        
        logger.info(
            f"Operation completed: {operation_name}",
            duration_ms=duration_ms,
            status=status,
            operation=operation_name
        )
        
        metrics.emit_duration_metric(
            f"Performance.{operation_name}.Duration",
            duration_ms,
            {'Status': status}
        )
        
        metrics.emit_count_metric(
            f"Performance.{operation_name}.Count",
            1,
            {'Status': status}
        )

def lambda_handler_wrapper(service_name: str, namespace: str = None):
    """
    Decorator for Lambda handlers that automatically sets up logging and metrics.
    
    Usage:
    @lambda_handler_wrapper('zengin-data-updater')
    def lambda_handler(event, context):
        # Your Lambda code here
        return {'statusCode': 200}
    """
    def decorator(handler_func):
        def wrapper(event, context):
            # Initialize logging and metrics
            environment = context.function_name.split('-')[0] if hasattr(context, 'function_name') else 'unknown'
            logger = StructuredLogger(service_name)
            metrics = MetricsEmitter(
                namespace or f"AdvasaBusinessBase/{environment}",
                environment,
                service_name
            )
            
            # Extract correlation ID from event
            correlation_id = None
            if isinstance(event, dict):
                # Try different sources for correlation ID
                correlation_id = (
                    event.get('correlation_id') or
                    event.get('headers', {}).get('x-correlation-id') or
                    event.get('requestContext', {}).get('requestId') or
                    str(uuid.uuid4())
                )
            else:
                correlation_id = str(uuid.uuid4())
            
            logger.set_correlation_id(correlation_id)
            
            # Log function start
            logger.info(
                f"Lambda function started: {context.function_name}",
                correlation_id=correlation_id,
                aws_request_id=context.aws_request_id,
                remaining_time_ms=context.get_remaining_time_in_millis(),
                event_type=event.get('Records', [{}])[0].get('eventName') if isinstance(event, dict) and 'Records' in event else 'direct_invoke'
            )
            
            # Emit invocation metric
            metrics.emit_business_metric('FunctionInvocation')
            
            start_time = time.time()
            try:
                # Call the actual handler
                result = handler_func(event, context, logger, metrics)
                
                # Log successful completion
                duration_ms = (time.time() - start_time) * 1000
                logger.info(
                    f"Lambda function completed successfully: {context.function_name}",
                    duration_ms=duration_ms,
                    correlation_id=correlation_id
                )
                
                # Emit success metrics
                metrics.emit_business_metric('FunctionSuccess')
                metrics.emit_duration_metric('FunctionDuration', duration_ms)
                
                return result
                
            except Exception as e:
                # Log error
                duration_ms = (time.time() - start_time) * 1000
                error_type = type(e).__name__
                
                logger.error(
                    f"Lambda function failed: {context.function_name}",
                    error=str(e),
                    error_type=error_type,
                    duration_ms=duration_ms,
                    correlation_id=correlation_id
                )
                
                # Emit error metrics
                metrics.emit_business_metric('FunctionError')
                metrics.emit_error_metric(error_type)
                
                # Re-raise the exception
                raise
        
        return wrapper
    return decorator

def extract_correlation_id_from_event(event: Dict[str, Any]) -> Optional[str]:
    """Extract correlation ID from various event sources"""
    if not isinstance(event, dict):
        return None
    
    # API Gateway
    if 'headers' in event:
        headers = event['headers'] or {}
        return headers.get('x-correlation-id') or headers.get('X-Correlation-ID')
    
    # SNS
    if 'Records' in event:
        for record in event['Records']:
            if record.get('EventSource') == 'aws:sns':
                message = json.loads(record.get('Sns', {}).get('Message', '{}'))
                if 'correlation_id' in message:
                    return message['correlation_id']
    
    # SQS
    if 'Records' in event:
        for record in event['Records']:
            if record.get('eventSource') == 'aws:sqs':
                attributes = record.get('messageAttributes', {})
                if 'correlation_id' in attributes:
                    return attributes['correlation_id']['stringValue']
    
    # Direct attribute
    return event.get('correlation_id')

def create_response(status_code: int, body: Dict[str, Any], correlation_id: Optional[str] = None) -> Dict[str, Any]:
    """Create a standardized API response with proper headers"""
    headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Correlation-ID',
    }
    
    if correlation_id:
        headers['X-Correlation-ID'] = correlation_id
    
    response_body = {
        'statusCode': status_code,
        'timestamp': datetime.utcnow().isoformat(),
        **body
    }
    
    if correlation_id:
        response_body['correlation_id'] = correlation_id
    
    return {
        'statusCode': status_code,
        'headers': headers,
        'body': json.dumps(response_body)
    }