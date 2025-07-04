import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

export interface CloudWatchMonitoringProps {
  environment: string;
  slackWebhookUrl?: string;
  emailEndpoints?: string[];
  lambdaFunctions?: lambda.Function[];
  apiGateways?: apigateway.RestApi[];
  customAlarms?: cloudwatch.Alarm[];
}

export class CloudWatchMonitoring extends Construct {
  public readonly alarmTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: CloudWatchMonitoringProps) {
    super(scope, id);

    // SNS Topic for alarm notifications
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `${props.environment}-monitoring-alarms`,
      topicName: `${props.environment}-monitoring-alarms`,
    });

    // Email subscriptions
    if (props.emailEndpoints) {
      props.emailEndpoints.forEach((email, index) => {
        this.alarmTopic.addSubscription(
          new subscriptions.EmailSubscription(email)
        );
      });
    }

    // Slack webhook subscription (if provided)
    if (props.slackWebhookUrl) {
      // Create Lambda function for Slack notifications
      const slackNotifier = new lambda.Function(this, 'SlackNotifier', {
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`
import json
import urllib3
import os

def handler(event, context):
    http = urllib3.PoolManager()
    
    webhook_url = os.environ['SLACK_WEBHOOK_URL']
    
    # Parse SNS message
    message = json.loads(event['Records'][0]['Sns']['Message'])
    
    slack_message = {
        "text": f"🚨 AWS CloudWatch Alarm: {message['AlarmName']}",
        "attachments": [
            {
                "color": "danger" if message['NewStateValue'] == 'ALARM' else "good",
                "fields": [
                    {"title": "Alarm", "value": message['AlarmName'], "short": True},
                    {"title": "State", "value": message['NewStateValue'], "short": True},
                    {"title": "Reason", "value": message['NewStateReason'], "short": False},
                    {"title": "Region", "value": message['Region'], "short": True},
                    {"title": "Account", "value": message['AWSAccountId'], "short": True},
                ]
            }
        ]
    }
    
    response = http.request(
        'POST',
        webhook_url,
        body=json.dumps(slack_message),
        headers={'Content-Type': 'application/json'}
    )
    
    return {'statusCode': 200}
        `),
        environment: {
          SLACK_WEBHOOK_URL: props.slackWebhookUrl,
        },
        timeout: cdk.Duration.seconds(30),
      });

      this.alarmTopic.addSubscription(
        new subscriptions.LambdaSubscription(slackNotifier)
      );
    }

    // Create CloudWatch Dashboard
    this.dashboard = new cloudwatch.Dashboard(this, 'MonitoringDashboard', {
      dashboardName: `${props.environment}-monitoring-dashboard`,
    });

    // Add Lambda function monitoring
    if (props.lambdaFunctions) {
      this.addLambdaMonitoring(props.lambdaFunctions, props.environment);
    }

    // Add API Gateway monitoring
    if (props.apiGateways) {
      this.addApiGatewayMonitoring(props.apiGateways, props.environment);
    }

    // Add custom alarms
    if (props.customAlarms) {
      props.customAlarms.forEach(alarm => {
        alarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      });
    }
  }

  private addLambdaMonitoring(functions: lambda.Function[], environment: string) {
    const lambdaWidgets: cloudwatch.IWidget[] = [];

    functions.forEach(func => {
      // Error rate alarm
      const errorAlarm = new cloudwatch.Alarm(this, `${func.functionName}-ErrorAlarm`, {
        metric: func.metricErrors({
          period: cdk.Duration.minutes(5),
        }),
        threshold: environment === 'prod' ? 5 : 10,
        evaluationPeriods: 2,
        alarmDescription: `High error rate for ${func.functionName}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      errorAlarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      this.alarms.push(errorAlarm);

      // Duration alarm
      const durationAlarm = new cloudwatch.Alarm(this, `${func.functionName}-DurationAlarm`, {
        metric: func.metricDuration({
          period: cdk.Duration.minutes(5),
        }),
        threshold: func.timeout ? func.timeout.toMilliseconds() * 0.8 : 30000,
        evaluationPeriods: 3,
        alarmDescription: `High duration for ${func.functionName}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      durationAlarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      this.alarms.push(durationAlarm);

      // Throttle alarm
      const throttleAlarm = new cloudwatch.Alarm(this, `${func.functionName}-ThrottleAlarm`, {
        metric: func.metricThrottles({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        alarmDescription: `Throttling detected for ${func.functionName}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      throttleAlarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      this.alarms.push(throttleAlarm);

      // Add to dashboard
      lambdaWidgets.push(
        new cloudwatch.GraphWidget({
          title: `${func.functionName} - Invocations & Errors`,
          left: [func.metricInvocations()],
          right: [func.metricErrors()],
          width: 12,
          height: 6,
        }),
        new cloudwatch.GraphWidget({
          title: `${func.functionName} - Duration & Throttles`,
          left: [func.metricDuration()],
          right: [func.metricThrottles()],
          width: 12,
          height: 6,
        })
      );
    });

    if (lambdaWidgets.length > 0) {
      this.dashboard.addWidgets(...lambdaWidgets);
    }
  }

  private addApiGatewayMonitoring(apis: apigateway.RestApi[], environment: string) {
    const apiWidgets: cloudwatch.IWidget[] = [];

    apis.forEach(api => {
      // 4XX Error alarm
      const clientErrorAlarm = new cloudwatch.Alarm(this, `${api.restApiName}-4XXAlarm`, {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: '4XXError',
          dimensionsMap: {
            ApiName: api.restApiName,
          },
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: environment === 'prod' ? 20 : 50,
        evaluationPeriods: 2,
        alarmDescription: `High 4XX error rate for ${api.restApiName}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      clientErrorAlarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      this.alarms.push(clientErrorAlarm);

      // 5XX Error alarm
      const serverErrorAlarm = new cloudwatch.Alarm(this, `${api.restApiName}-5XXAlarm`, {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: '5XXError',
          dimensionsMap: {
            ApiName: api.restApiName,
          },
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: environment === 'prod' ? 5 : 10,
        evaluationPeriods: 1,
        alarmDescription: `High 5XX error rate for ${api.restApiName}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      serverErrorAlarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      this.alarms.push(serverErrorAlarm);

      // Latency alarm
      const latencyAlarm = new cloudwatch.Alarm(this, `${api.restApiName}-LatencyAlarm`, {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: 'Latency',
          dimensionsMap: {
            ApiName: api.restApiName,
          },
          period: cdk.Duration.minutes(5),
          statistic: 'Average',
        }),
        threshold: environment === 'prod' ? 5000 : 10000,
        evaluationPeriods: 3,
        alarmDescription: `High latency for ${api.restApiName}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      latencyAlarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      this.alarms.push(latencyAlarm);

      // Add to dashboard
      apiWidgets.push(
        new cloudwatch.GraphWidget({
          title: `${api.restApiName} - Requests & Errors`,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'Count',
              dimensionsMap: { ApiName: api.restApiName },
            }),
          ],
          right: [
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: '4XXError',
              dimensionsMap: { ApiName: api.restApiName },
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: '5XXError',
              dimensionsMap: { ApiName: api.restApiName },
            }),
          ],
          width: 12,
          height: 6,
        }),
        new cloudwatch.GraphWidget({
          title: `${api.restApiName} - Latency`,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'Latency',
              dimensionsMap: { ApiName: api.restApiName },
              statistic: 'Average',
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/ApiGateway',
              metricName: 'IntegrationLatency',
              dimensionsMap: { ApiName: api.restApiName },
              statistic: 'Average',
            }),
          ],
          width: 12,
          height: 6,
        })
      );
    });

    if (apiWidgets.length > 0) {
      this.dashboard.addWidgets(...apiWidgets);
    }
  }

  public addCustomMetric(
    metricName: string,
    namespace: string,
    threshold: number,
    alarmName: string,
    alarmDescription: string,
    dimensions?: Record<string, string>
  ): cloudwatch.Alarm {
    const metric = new cloudwatch.Metric({
      namespace,
      metricName,
      dimensionsMap: dimensions,
      period: cdk.Duration.minutes(5),
    });

    const alarm = new cloudwatch.Alarm(this, alarmName, {
      metric,
      threshold,
      evaluationPeriods: 2,
      alarmDescription,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    alarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));
    this.alarms.push(alarm);

    return alarm;
  }
}