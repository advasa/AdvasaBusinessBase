import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CustomMetricsProps {
  environment: string;
  namespace: string;
  lambdaFunctions?: lambda.Function[];
}

export class CustomMetrics extends Construct {
  public readonly namespace: string;
  public readonly metricsLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: CustomMetricsProps) {
    super(scope, id);

    this.namespace = props.namespace;

    // Create a utility Lambda function for emitting custom metrics
    this.metricsLambda = new lambda.Function(this, 'MetricsUtility', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3
import json
import os
from datetime import datetime
from typing import Dict, Any

cloudwatch = boto3.client('cloudwatch')

def emit_metric(metric_name: str, value: float, unit: str = 'Count', dimensions: Dict[str, str] = None):
    """Emit a custom metric to CloudWatch"""
    namespace = os.environ.get('METRICS_NAMESPACE', 'CustomMetrics')
    
    metric_data = {
        'MetricName': metric_name,
        'Value': value,
        'Unit': unit,
        'Timestamp': datetime.utcnow()
    }
    
    if dimensions:
        metric_data['Dimensions'] = [
            {'Name': k, 'Value': v} for k, v in dimensions.items()
        ]
    
    try:
        cloudwatch.put_metric_data(
            Namespace=namespace,
            MetricData=[metric_data]
        )
        print(f"Emitted metric: {metric_name} = {value} {unit}")
        return True
    except Exception as e:
        print(f"Failed to emit metric {metric_name}: {str(e)}")
        return False

def emit_business_metric(event_type: str, count: int = 1, dimensions: Dict[str, str] = None):
    """Emit business-specific metrics"""
    base_dimensions = {
        'Environment': os.environ.get('ENVIRONMENT', 'unknown'),
        'Service': os.environ.get('SERVICE_NAME', 'unknown')
    }
    
    if dimensions:
        base_dimensions.update(dimensions)
    
    return emit_metric(f"Business.{event_type}", count, 'Count', base_dimensions)

def emit_performance_metric(operation: str, duration_ms: float, success: bool = True):
    """Emit performance metrics"""
    dimensions = {
        'Operation': operation,
        'Status': 'Success' if success else 'Error',
        'Environment': os.environ.get('ENVIRONMENT', 'unknown')
    }
    
    emit_metric(f"Performance.Duration", duration_ms, 'Milliseconds', dimensions)
    emit_metric(f"Performance.{operation}.Count", 1, 'Count', dimensions)

def handler(event, context):
    """Lambda handler for emitting metrics"""
    try:
        metric_type = event.get('type', 'custom')
        
        if metric_type == 'business':
            return emit_business_metric(
                event['event_type'],
                event.get('count', 1),
                event.get('dimensions')
            )
        elif metric_type == 'performance':
            return emit_performance_metric(
                event['operation'],
                event['duration_ms'],
                event.get('success', True)
            )
        elif metric_type == 'custom':
            return emit_metric(
                event['metric_name'],
                event['value'],
                event.get('unit', 'Count'),
                event.get('dimensions')
            )
        else:
            raise ValueError(f"Unknown metric type: {metric_type}")
            
    except Exception as e:
        print(f"Error processing metric event: {str(e)}")
        return False
      `),
      environment: {
        METRICS_NAMESPACE: this.namespace,
        ENVIRONMENT: props.environment,
      },
      timeout: cdk.Duration.seconds(30),
    });

    // Add CloudWatch permissions
    this.metricsLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      })
    );

    // Add CloudWatch permissions to other Lambda functions for custom metrics
    if (props.lambdaFunctions) {
      props.lambdaFunctions.forEach(func => {
        func.addToRolePolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
          })
        );

        // Add metrics utility environment variables
        func.addEnvironment('METRICS_NAMESPACE', this.namespace);
        func.addEnvironment('METRICS_LAMBDA_ARN', this.metricsLambda.functionArn);
      });
    }
  }

  public createBusinessMetrics(): cloudwatch.Metric[] {
    return [
      new cloudwatch.Metric({
        namespace: this.namespace,
        metricName: 'Business.TransactionCount',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      new cloudwatch.Metric({
        namespace: this.namespace,
        metricName: 'Business.SuccessRate',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      new cloudwatch.Metric({
        namespace: this.namespace,
        metricName: 'Business.ErrorRate',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
    ];
  }

  public createPerformanceMetrics(): cloudwatch.Metric[] {
    return [
      new cloudwatch.Metric({
        namespace: this.namespace,
        metricName: 'Performance.Duration',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      new cloudwatch.Metric({
        namespace: this.namespace,
        metricName: 'Performance.ProcessingTime',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      new cloudwatch.Metric({
        namespace: this.namespace,
        metricName: 'Performance.ThroughputPerMinute',
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
      }),
    ];
  }

  public createSystemMetrics(): cloudwatch.Metric[] {
    return [
      new cloudwatch.Metric({
        namespace: this.namespace,
        metricName: 'System.MemoryUtilization',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      new cloudwatch.Metric({
        namespace: this.namespace,
        metricName: 'System.ConcurrentConnections',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      new cloudwatch.Metric({
        namespace: this.namespace,
        metricName: 'System.QueueDepth',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
    ];
  }
}