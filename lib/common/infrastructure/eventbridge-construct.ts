import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Config } from '../config';

export interface EventBridgeConstructProps {
  config: Config;
  eventBusName?: string;
  schedulerGroupName: string;
}

export interface ScheduleConfig {
  scheduleName: string;
  scheduleExpression: string;
  targetFunction: lambda.Function;
  description?: string;
  inputPayload?: any;
  flexibleTimeWindow?: {
    mode: 'FLEXIBLE' | 'OFF';
    maximumWindowInMinutes?: number;
  };
}

export class EventBridgeConstruct extends Construct {
  public readonly eventBus: events.IEventBus;
  public readonly schedulerGroup: scheduler.CfnScheduleGroup;
  public readonly schedulerRole: iam.Role;

  constructor(scope: Construct, id: string, props: EventBridgeConstructProps) {
    super(scope, id);

    const { config, eventBusName, schedulerGroupName } = props;

    // EventBusを作成（デフォルトバスを使用する場合はスキップ）
    if (eventBusName) {
      const customEventBus = new events.EventBus(this, 'EventBus', {
        eventBusName,
      });
      this.eventBus = customEventBus;

      // タグを追加
      cdk.Tags.of(customEventBus).add('Component', 'EventBridge');
      cdk.Tags.of(customEventBus).add('Service', 'EventRouting');
    } else {
      // デフォルトEventBusを参照
      this.eventBus = events.EventBus.fromEventBusName(this, 'DefaultEventBus', 'default');
    }

    // EventBridge Scheduler用のIAMロールを作成
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role for EventBridge Scheduler to invoke Lambda functions',
      inlinePolicies: {
        SchedulerExecutionPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['lambda:InvokeFunction'],
              resources: ['*'], // 後でLambda関数の権限を個別に追加
            }),
          ],
        }),
      },
    });

    // EventBridge Scheduler Group を作成
    this.schedulerGroup = new scheduler.CfnScheduleGroup(this, 'SchedulerGroup', {
      name: schedulerGroupName,
    });

    // タグを追加
    cdk.Tags.of(this.schedulerRole).add('Component', 'EventBridge');
    cdk.Tags.of(this.schedulerRole).add('Service', 'Scheduling');

    // CloudFormation出力
    new cdk.CfnOutput(this, 'EventBusName', {
      value: this.eventBus.eventBusName,
      description: 'EventBridge Event Bus name',
      exportName: `${config.env}-${config.projectName}-${id}-EventBusName`,
    });

    new cdk.CfnOutput(this, 'EventBusArn', {
      value: this.eventBus.eventBusArn,
      description: 'EventBridge Event Bus ARN',
      exportName: `${config.env}-${config.projectName}-${id}-EventBusArn`,
    });

    new cdk.CfnOutput(this, 'SchedulerGroupName', {
      value: this.schedulerGroup.name || schedulerGroupName,
      description: 'EventBridge Scheduler Group name',
      exportName: `${config.env}-${config.projectName}-${id}-SchedulerGroupName`,
    });

    new cdk.CfnOutput(this, 'SchedulerRoleArn', {
      value: this.schedulerRole.roleArn,
      description: 'EventBridge Scheduler Role ARN',
      exportName: `${config.env}-${config.projectName}-${id}-SchedulerRoleArn`,
    });
  }

  /**
   * Lambda関数に定期実行スケジュールを追加
   * @param scheduleConfig スケジュール設定
   */
  public addSchedule(scheduleConfig: ScheduleConfig): scheduler.CfnSchedule {
    const {
      scheduleName,
      scheduleExpression,
      targetFunction,
      description,
      inputPayload,
      flexibleTimeWindow = { mode: 'OFF' },
    } = scheduleConfig;

    // Lambda関数の実行権限をSchedulerロールに付与
    targetFunction.grantInvoke(this.schedulerRole);

    // スケジュールを作成
    const schedule = new scheduler.CfnSchedule(this, scheduleName, {
      groupName: this.schedulerGroup.name,
      name: scheduleName,
      scheduleExpression,
      description: description || `Schedule for ${targetFunction.functionName}`,
      flexibleTimeWindow,
      target: {
        arn: targetFunction.functionArn,
        roleArn: this.schedulerRole.roleArn,
        input: inputPayload ? JSON.stringify(inputPayload) : undefined,
      },
    });

    // スケジュールがSchedulerGroupに依存することを明示
    schedule.addDependency(this.schedulerGroup);

    return schedule;
  }

  /**
   * EventBridgeルールを作成してLambda関数をターゲットに設定
   * @param ruleName ルール名
   * @param eventPattern イベントパターン
   * @param targetFunction ターゲットのLambda関数
   * @param description ルールの説明
   */
  public addRule(
    ruleName: string,
    eventPattern: events.EventPattern,
    targetFunction: lambda.Function,
    description?: string
  ): events.Rule {
    const rule = new events.Rule(this, ruleName, {
      eventBus: this.eventBus,
      eventPattern,
      description: description || `Rule for ${targetFunction.functionName}`,
    });

    // Lambda関数をターゲットに追加
    rule.addTarget(new targets.LambdaFunction(targetFunction));

    return rule;
  }

  /**
   * カスタムイベントを送信するヘルパーメソッド
   * @param source イベントソース
   * @param detailType イベントの詳細タイプ
   * @param detail イベントの詳細データ
   */
  public putEvent(source: string, detailType: string, detail: any): void {
    // 実際の実装では、AWS SDKを使用してイベントを送信
    // ここではCDKのコンストラクト定義のみ
  }

  /**
   * Lambda関数にEventBridgeへの送信権限を付与
   * @param lambdaFunction Lambda関数
   */
  public grantPutEventsTo(lambdaFunction: lambda.Function): iam.Grant {
    return this.eventBus.grantPutEventsTo(lambdaFunction);
  }

  /**
   * 一回限りのスケジュール実行を作成（動的スケジュール用）
   * @param scheduleName スケジュール名
   * @param executeAt 実行日時（ISO文字列）
   * @param targetFunction ターゲットのLambda関数
   * @param inputPayload 入力ペイロード
   */
  public createOneTimeSchedule(
    scheduleName: string,
    executeAt: string,
    targetFunction: lambda.Function,
    inputPayload?: any
  ): scheduler.CfnSchedule {
    // Lambda関数の実行権限をSchedulerロールに付与
    targetFunction.grantInvoke(this.schedulerRole);

    // at()式を使用した一回限りのスケジュール
    const schedule = new scheduler.CfnSchedule(this, scheduleName, {
      groupName: this.schedulerGroup.name,
      name: scheduleName,
      scheduleExpression: `at(${executeAt})`,
      description: `One-time execution for ${targetFunction.functionName}`,
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: targetFunction.functionArn,
        roleArn: this.schedulerRole.roleArn,
        input: inputPayload ? JSON.stringify(inputPayload) : undefined,
      },
    });

    // スケジュールがSchedulerGroupに依存することを明示
    schedule.addDependency(this.schedulerGroup);

    return schedule;
  }

  /**
   * スケジュールを削除するヘルパーメソッド
   * 注意: CDKでは動的な削除は直接サポートされていないため、
   * 実際の削除はLambda関数内でAWS SDKを使用して行う
   */
  public getSchedulerGroupName(): string {
    return this.schedulerGroup.name || '';
  }

  /**
   * EventBridgeのメトリクスを取得するメソッド
   */
  public metricSuccessfulInvocations(): cdk.aws_cloudwatch.Metric {
    return new cdk.aws_cloudwatch.Metric({
      namespace: 'AWS/Events',
      metricName: 'SuccessfulInvocations',
      dimensionsMap: {
        EventBusName: this.eventBus.eventBusName,
      },
    });
  }

  public metricFailedInvocations(): cdk.aws_cloudwatch.Metric {
    return new cdk.aws_cloudwatch.Metric({
      namespace: 'AWS/Events',
      metricName: 'FailedInvocations',
      dimensionsMap: {
        EventBusName: this.eventBus.eventBusName,
      },
    });
  }
}