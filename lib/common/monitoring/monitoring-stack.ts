import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { CloudWatchMonitoring } from './cloudwatch-construct';
import { XRayTracing } from './x-ray-construct';
import { CustomMetrics } from './custom-metrics-construct';
import { EnhancedLogging } from './enhanced-logging-construct';

export interface MonitoringStackProps extends cdk.StackProps {
  environment: string;
  slackWebhookUrl?: string;
  emailEndpoints?: string[];
  enableXRayTracing?: boolean;
  enableCustomMetrics?: boolean;
  enableEnhancedLogging?: boolean;
  lambdaFunctions?: lambda.Function[];
  apiGateways?: apigateway.RestApi[];
}

export class MonitoringStack extends cdk.Stack {
  public readonly cloudWatchMonitoring: CloudWatchMonitoring;
  public readonly xrayTracing?: XRayTracing;
  public readonly customMetrics?: CustomMetrics;
  public readonly enhancedLogging?: EnhancedLogging;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    // Core CloudWatch monitoring
    this.cloudWatchMonitoring = new CloudWatchMonitoring(this, 'CloudWatchMonitoring', {
      environment: props.environment,
      slackWebhookUrl: props.slackWebhookUrl,
      emailEndpoints: props.emailEndpoints,
      lambdaFunctions: props.lambdaFunctions,
      apiGateways: props.apiGateways,
    });

    // X-Ray tracing (optional)
    if (props.enableXRayTracing) {
      this.xrayTracing = new XRayTracing(this, 'XRayTracing', {
        environment: props.environment,
        lambdaFunctions: props.lambdaFunctions,
        apiGateways: props.apiGateways,
        enableActiveTracing: true,
        samplingRate: props.environment === 'prod' ? 0.1 : 0.5,
      });
    }

    // Custom metrics (optional)
    if (props.enableCustomMetrics) {
      this.customMetrics = new CustomMetrics(this, 'CustomMetrics', {
        environment: props.environment,
        namespace: `AdvașaBusinessBase/${props.environment}`,
        lambdaFunctions: props.lambdaFunctions,
      });

      // Add custom metrics to dashboard
      if (this.customMetrics) {
        const businessMetrics = this.customMetrics.createBusinessMetrics();
        const performanceMetrics = this.customMetrics.createPerformanceMetrics();
        const systemMetrics = this.customMetrics.createSystemMetrics();

        this.cloudWatchMonitoring.dashboard.addWidgets(
          new cdk.aws_cloudwatch.GraphWidget({
            title: 'Business Metrics',
            left: businessMetrics.slice(0, 2),
            right: businessMetrics.slice(2),
            width: 12,
            height: 6,
          }),
          new cdk.aws_cloudwatch.GraphWidget({
            title: 'Performance Metrics',
            left: performanceMetrics.slice(0, 2),
            right: performanceMetrics.slice(2),
            width: 12,
            height: 6,
          }),
          new cdk.aws_cloudwatch.GraphWidget({
            title: 'System Metrics',
            left: systemMetrics.slice(0, 2),
            right: systemMetrics.slice(2),
            width: 12,
            height: 6,
          })
        );
      }
    }

    // Enhanced logging (optional)
    if (props.enableEnhancedLogging) {
      this.enhancedLogging = new EnhancedLogging(this, 'EnhancedLogging', {
        environment: props.environment,
        lambdaFunctions: props.lambdaFunctions,
        enableMetricFilters: true,
      });

      // Add structured logging to Lambda functions
      if (props.lambdaFunctions) {
        props.lambdaFunctions.forEach(func => {
          this.enhancedLogging!.addStructuredLoggingToLambda(func);
        });
      }
    }

    // Output important monitoring resources
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.cloudWatchMonitoring.dashboard.dashboardName}`,
      description: 'CloudWatch Dashboard URL',
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.cloudWatchMonitoring.alarmTopic.topicArn,
      description: 'SNS Topic ARN for alarm notifications',
    });

    if (this.enhancedLogging) {
      new cdk.CfnOutput(this, 'CentralLogGroupName', {
        value: this.enhancedLogging.centralLogGroup.logGroupName,
        description: 'Central log group for aggregated logging',
      });
    }

    // Create summary widget for the dashboard
    this.addSummaryWidget();
  }

  private addSummaryWidget() {
    // Add a summary widget to the top of the dashboard
    const summaryWidget = new cdk.aws_cloudwatch.TextWidget({
      markdown: `
# AdvasaBusinessBase Monitoring Dashboard

**Environment:** ${this.stackName}  
**Last Updated:** ${new Date().toISOString()}

## Key Metrics Overview
- **Lambda Functions:** ${this.cloudWatchMonitoring.alarms.length} alarms configured
- **API Gateway:** Monitoring enabled for all APIs
- **X-Ray Tracing:** ${this.xrayTracing ? 'Enabled' : 'Disabled'}
- **Custom Metrics:** ${this.customMetrics ? 'Enabled' : 'Disabled'}
- **Enhanced Logging:** ${this.enhancedLogging ? 'Enabled' : 'Disabled'}

## Quick Links
- [CloudWatch Logs Insights](https://console.aws.amazon.com/cloudwatch/home#logsV2:logs-insights)
- [X-Ray Service Map](https://console.aws.amazon.com/xray/home#/service-map)
- [Lambda Functions](https://console.aws.amazon.com/lambda/home#/functions)
- [API Gateway](https://console.aws.amazon.com/apigateway/home#/apis)

## Alert Thresholds
- **Error Rate:** ${this.stackName === 'prod' ? '5 errors/5min' : '10 errors/5min'}
- **Latency:** ${this.stackName === 'prod' ? '5s avg' : '10s avg'}
- **4XX Errors:** ${this.stackName === 'prod' ? '20/5min' : '50/5min'}
- **5XX Errors:** ${this.stackName === 'prod' ? '5/5min' : '10/5min'}
      `,
      width: 24,
      height: 8,
    });

    // Insert summary widget at the beginning
    this.cloudWatchMonitoring.dashboard.addWidgets(summaryWidget);
  }

  public addCustomAlarm(
    metricName: string,
    namespace: string,
    threshold: number,
    alarmName: string,
    alarmDescription: string,
    dimensions?: Record<string, string>
  ) {
    return this.cloudWatchMonitoring.addCustomMetric(
      metricName,
      namespace,
      threshold,
      alarmName,
      alarmDescription,
      dimensions
    );
  }
}