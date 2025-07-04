import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface EnhancedLoggingProps {
  environment: string;
  lambdaFunctions?: lambda.Function[];
  centralLogGroupName?: string;
  retentionDays?: logs.RetentionDays;
  enableMetricFilters?: boolean;
}

export class EnhancedLogging extends Construct {
  public readonly centralLogGroup: logs.LogGroup;
  public readonly metricFilters: logs.MetricFilter[] = [];

  constructor(scope: Construct, id: string, props: EnhancedLoggingProps) {
    super(scope, id);

    const retentionDays = props.retentionDays ?? 
      (props.environment === 'prod' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS);

    // Create central log group for aggregated logging
    this.centralLogGroup = new logs.LogGroup(this, 'CentralLogGroup', {
      logGroupName: props.centralLogGroupName ?? `/aws/lambda/${props.environment}/central`,
      retention: retentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create log aggregation Lambda function
    const logAggregator = new lambda.Function(this, 'LogAggregator', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import gzip
import base64
import os
from datetime import datetime
from typing import Dict, Any

logs_client = boto3.client('logs')

def parse_log_event(log_event: Dict[str, Any]) -> Dict[str, Any]:
    """Parse and enrich log events"""
    try:
        # Try to parse as JSON
        if log_event['message'].strip().startswith('{'):
            message_data = json.loads(log_event['message'])
        else:
            message_data = {'message': log_event['message']}
    except:
        message_data = {'message': log_event['message']}
    
    # Add metadata
    enriched_event = {
        'timestamp': log_event['timestamp'],
        'id': log_event['id'],
        'environment': os.environ.get('ENVIRONMENT', 'unknown'),
        'log_level': extract_log_level(log_event['message']),
        'source': extract_source_from_log_group(log_event.get('logGroup', '')),
        **message_data
    }
    
    return enriched_event

def extract_log_level(message: str) -> str:
    """Extract log level from message"""
    message_upper = message.upper()
    for level in ['ERROR', 'WARN', 'INFO', 'DEBUG']:
        if level in message_upper:
            return level
    return 'INFO'

def extract_source_from_log_group(log_group: str) -> str:
    """Extract service name from log group"""
    if '/aws/lambda/' in log_group:
        return log_group.split('/')[-1]
    return 'unknown'

def emit_metric_from_log(event_data: Dict[str, Any]):
    """Emit CloudWatch metrics based on log content"""
    cloudwatch = boto3.client('cloudwatch')
    
    try:
        metric_data = []
        
        # Error count metric
        if event_data.get('log_level') == 'ERROR':
            metric_data.append({
                'MetricName': 'LogErrors',
                'Value': 1,
                'Unit': 'Count',
                'Dimensions': [
                    {'Name': 'Source', 'Value': event_data.get('source', 'unknown')},
                    {'Name': 'Environment', 'Value': event_data.get('environment', 'unknown')}
                ]
            })
        
        # Custom business metrics
        if 'transaction_id' in event_data:
            metric_data.append({
                'MetricName': 'TransactionCount',
                'Value': 1,
                'Unit': 'Count',
                'Dimensions': [
                    {'Name': 'Source', 'Value': event_data.get('source', 'unknown')},
                    {'Name': 'Environment', 'Value': event_data.get('environment', 'unknown')}
                ]
            })
        
        if metric_data:
            cloudwatch.put_metric_data(
                Namespace=f"Logs/{event_data.get('environment', 'unknown')}",
                MetricData=metric_data
            )
    except Exception as e:
        print(f"Failed to emit metrics from log: {str(e)}")

def handler(event, context):
    """Process CloudWatch Logs events"""
    try:
        # Decode CloudWatch Logs data
        compressed_payload = base64.b64decode(event['awslogs']['data'])
        uncompressed_payload = gzip.decompress(compressed_payload)
        log_data = json.loads(uncompressed_payload)
        
        central_log_group = os.environ['CENTRAL_LOG_GROUP']
        
        # Process each log event
        for log_event in log_data['logEvents']:
            enriched_event = parse_log_event(log_event)
            
            # Send to central log group
            try:
                logs_client.put_log_events(
                    logGroupName=central_log_group,
                    logStreamName=f"{enriched_event['source']}/{datetime.now().strftime('%Y/%m/%d')}",
                    logEvents=[{
                        'timestamp': enriched_event['timestamp'],
                        'message': json.dumps(enriched_event)
                    }]
                )
            except logs_client.exceptions.ResourceNotFoundException:
                # Create log stream if it doesn't exist
                try:
                    logs_client.create_log_stream(
                        logGroupName=central_log_group,
                        logStreamName=f"{enriched_event['source']}/{datetime.now().strftime('%Y/%m/%d')}"
                    )
                    logs_client.put_log_events(
                        logGroupName=central_log_group,
                        logStreamName=f"{enriched_event['source']}/{datetime.now().strftime('%Y/%m/%d')}",
                        logEvents=[{
                            'timestamp': enriched_event['timestamp'],
                            'message': json.dumps(enriched_event)
                        }]
                    )
                except Exception as e:
                    print(f"Failed to create log stream: {str(e)}")
            
            # Emit metrics from log content
            emit_metric_from_log(enriched_event)
        
        return {'statusCode': 200, 'processed': len(log_data['logEvents'])}
        
    except Exception as e:
        print(f"Error processing log events: {str(e)}")
        return {'statusCode': 500, 'error': str(e)}
      `),
      environment: {
        CENTRAL_LOG_GROUP: this.centralLogGroup.logGroupName,
        ENVIRONMENT: props.environment,
      },
      timeout: cdk.Duration.minutes(5),
    });

    // Add permissions for log aggregator
    logAggregator.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
          'cloudwatch:PutMetricData',
        ],
        resources: ['*'],
      })
    );

    // Setup log subscriptions for Lambda functions
    if (props.lambdaFunctions) {
      props.lambdaFunctions.forEach((func, index) => {
        const subscription = new logs.SubscriptionFilter(this, `LogSubscription${index}`, {
          logGroup: func.logGroup,
          destination: new destinations.LambdaDestination(logAggregator),
          filterPattern: logs.FilterPattern.allEvents(),
        });
      });
    }

    // Create metric filters if enabled
    if (props.enableMetricFilters) {
      this.createMetricFilters(props.environment);
    }
  }

  private createMetricFilters(environment: string) {
    // Error count metric filter
    const errorFilter = new logs.MetricFilter(this, 'ErrorMetricFilter', {
      logGroup: this.centralLogGroup,
      metricNamespace: `Logs/${environment}`,
      metricName: 'ErrorCount',
      filterPattern: logs.FilterPattern.literal('[timestamp, id, env="ERROR", ...]'),
      metricValue: '1',
      defaultValue: 0,
    });
    this.metricFilters.push(errorFilter);

    // Warning count metric filter
    const warningFilter = new logs.MetricFilter(this, 'WarningMetricFilter', {
      logGroup: this.centralLogGroup,
      metricNamespace: `Logs/${environment}`,
      metricName: 'WarningCount',
      filterPattern: logs.FilterPattern.literal('[timestamp, id, env="WARN", ...]'),
      metricValue: '1',
      defaultValue: 0,
    });
    this.metricFilters.push(warningFilter);

    // Transaction count metric filter
    const transactionFilter = new logs.MetricFilter(this, 'TransactionMetricFilter', {
      logGroup: this.centralLogGroup,
      metricNamespace: `Logs/${environment}`,
      metricName: 'TransactionCount',
      filterPattern: logs.FilterPattern.literal('[..., transaction_id, ...]'),
      metricValue: '1',
      defaultValue: 0,
    });
    this.metricFilters.push(transactionFilter);
  }

  public addStructuredLoggingToLambda(func: lambda.Function) {
    // Add structured logging environment variables
    func.addEnvironment('LOG_LEVEL', 'INFO');
    func.addEnvironment('STRUCTURED_LOGGING', 'true');
    func.addEnvironment('CORRELATION_ID_HEADER', 'x-correlation-id');
  }

  public createLogInsightsQueries(): string[] {
    return [
      // Error analysis query
      `fields @timestamp, source, message
       | filter log_level = "ERROR"
       | sort @timestamp desc
       | limit 100`,
      
      // Performance analysis query
      `fields @timestamp, source, @duration
       | filter @duration > 1000
       | sort @duration desc
       | limit 50`,
      
      // Transaction analysis query
      `fields @timestamp, source, transaction_id, message
       | filter ispresent(transaction_id)
       | sort @timestamp desc
       | limit 100`,
      
      // Error rate by source
      `fields source
       | filter log_level = "ERROR"
       | stats count() by source
       | sort count desc`,
    ];
  }
}