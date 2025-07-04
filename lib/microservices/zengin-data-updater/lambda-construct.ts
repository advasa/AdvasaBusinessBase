import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { Config, LambdaConfig } from '../../common/config';

export interface LambdaConstructProps {
  config: Config;
  functionName: string;
  description: string;
  codePath: string;
  handler: string;
  lambdaConfig: LambdaConfig;
  vpc?: ec2.IVpc;
  securityGroups?: ec2.ISecurityGroup[];
  vpcSubnets?: ec2.SubnetSelection;
  environment?: Record<string, string>;
  layers?: lambda.ILayerVersion[];
  deadLetterQueue?: boolean;
  reservedConcurrency?: number;
}

export class LambdaConstruct extends Construct {
  public readonly function: lambda.Function;
  public readonly logGroup: logs.LogGroup;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: LambdaConstructProps) {
    super(scope, id);

    const {
      config,
      functionName,
      description,
      codePath,
      handler,
      lambdaConfig,
      vpc,
      securityGroups,
      vpcSubnets,
      environment = {},
      layers = [],
      deadLetterQueue = false,
      reservedConcurrency,
    } = props;

    // IAMロールを作成
    this.role = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Execution role for ${functionName}`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // VPC内での実行の場合はVPCアクセス権限を追加
    if (vpc) {
      this.role.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
      );
    }

    // CloudWatch Logsグループを作成
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: this.getLogRetention(lambdaConfig.logRetentionDays),
      removalPolicy: config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Lambda関数のプロパティを設定
    const functionProps: lambda.FunctionProps = {
      functionName,
      description,
      runtime: this.getRuntime(lambdaConfig.runtime),
      handler,
      code: lambda.Code.fromAsset(codePath),
      timeout: cdk.Duration.seconds(lambdaConfig.timeout),
      memorySize: lambdaConfig.memorySize,
      role: this.role,
      environment: {
        ...lambdaConfig.environment,
        ...environment,
        LOG_LEVEL: environment.LOG_LEVEL || (config.env === 'prod' ? 'INFO' : 'DEBUG'),
        ENVIRONMENT: config.env,
      },
      layers,
      logGroup: this.logGroup,
      ...(vpc && securityGroups && vpcSubnets && {
        vpc,
        securityGroups,
        vpcSubnets,
      }),
      ...(reservedConcurrency !== undefined && {
        reservedConcurrentExecutions: reservedConcurrency,
      }),
    };

    // Lambda関数を作成
    this.function = new lambda.Function(this, 'Function', functionProps);

    // タグを追加
    this.addTags(config, functionName);

    // CloudFormation出力
    this.createOutputs(config, id);

    // CloudWatch カスタムメトリクス権限を追加
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      })
    );

    // X-Rayトレーシングを有効化
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      })
    );

    // 監視用環境変数を追加
    this.function.addEnvironment('METRICS_NAMESPACE', `AdvasaBusinessBase/${config.env}`);
    this.function.addEnvironment('SERVICE_NAME', functionName);
    this.function.addEnvironment('STRUCTURED_LOGGING', 'true');
  }

  /**
   * Lambda関数にカスタムポリシーを追加
   */
  public addToRolePolicy(statement: iam.PolicyStatement): void {
    this.role.addToPolicy(statement);
  }

  /**
   * Lambda関数に管理ポリシーを追加
   */
  public addManagedPolicy(managedPolicy: iam.IManagedPolicy): void {
    this.role.addManagedPolicy(managedPolicy);
  }

  /**
   * 環境変数を追加
   */
  public addEnvironment(key: string, value: string): void {
    this.function.addEnvironment(key, value);
  }

  /**
   * Lambda関数のエイリアスを作成
   */
  public createAlias(aliasName: string, version: lambda.IVersion): lambda.Alias {
    return new lambda.Alias(this, `${aliasName}Alias`, {
      aliasName,
      version,
    });
  }

  /**
   * Lambda関数のバージョンを作成
   */
  public createVersion(versionName?: string): lambda.Version {
    return new lambda.Version(this, `Version${versionName || 'Latest'}`, {
      lambda: this.function,
    });
  }

  /**
   * イベントソースマッピングを作成
   */
  public addEventSourceMapping(
    eventSourceArn: string,
    batchSize?: number,
    startingPosition?: lambda.StartingPosition
  ): lambda.EventSourceMapping {
    return new lambda.EventSourceMapping(this, 'EventSourceMapping', {
      target: this.function,
      eventSourceArn,
      batchSize: batchSize || 10,
      startingPosition: startingPosition || lambda.StartingPosition.LATEST,
    });
  }

  /**
   * Lambdaランタイムを取得
   */
  private getRuntime(runtimeString: string): lambda.Runtime {
    switch (runtimeString) {
      case 'python3.11':
        return lambda.Runtime.PYTHON_3_11;
      case 'python3.10':
        return lambda.Runtime.PYTHON_3_10;
      case 'python3.9':
        return lambda.Runtime.PYTHON_3_9;
      case 'nodejs18.x':
        return lambda.Runtime.NODEJS_18_X;
      case 'nodejs16.x':
        return lambda.Runtime.NODEJS_16_X;
      default:
        return lambda.Runtime.PYTHON_3_11;
    }
  }

  /**
   * ログ保持期間を取得
   */
  private getLogRetention(days: number): logs.RetentionDays {
    switch (days) {
      case 1:
        return logs.RetentionDays.ONE_DAY;
      case 3:
        return logs.RetentionDays.THREE_DAYS;
      case 5:
        return logs.RetentionDays.FIVE_DAYS;
      case 7:
        return logs.RetentionDays.ONE_WEEK;
      case 14:
        return logs.RetentionDays.TWO_WEEKS;
      case 30:
        return logs.RetentionDays.ONE_MONTH;
      case 60:
        return logs.RetentionDays.TWO_MONTHS;
      case 90:
        return logs.RetentionDays.THREE_MONTHS;
      case 120:
        return logs.RetentionDays.FOUR_MONTHS;
      case 150:
        return logs.RetentionDays.FIVE_MONTHS;
      case 180:
        return logs.RetentionDays.SIX_MONTHS;
      case 365:
        return logs.RetentionDays.ONE_YEAR;
      case 730:
        return logs.RetentionDays.TWO_YEARS;
      case 1827:
        return logs.RetentionDays.FIVE_YEARS;
      case 3653:
        return logs.RetentionDays.TEN_YEARS;
      default:
        return logs.RetentionDays.TWO_WEEKS;
    }
  }

  /**
   * タグを追加
   */
  private addTags(config: Config, functionName: string): void {
    cdk.Tags.of(this.function).add('Component', 'Lambda');
    cdk.Tags.of(this.function).add('Service', 'ZenginDataUpdater');
    cdk.Tags.of(this.function).add('FunctionName', functionName);

    cdk.Tags.of(this.logGroup).add('Component', 'CloudWatchLogs');
    cdk.Tags.of(this.logGroup).add('Service', 'ZenginDataUpdater');
    cdk.Tags.of(this.logGroup).add('FunctionName', functionName);

    cdk.Tags.of(this.role).add('Component', 'IAM');
    cdk.Tags.of(this.role).add('Service', 'ZenginDataUpdater');
    cdk.Tags.of(this.role).add('FunctionName', functionName);
  }

  /**
   * CloudFormation出力
   */
  private createOutputs(config: Config, id: string): void {
    new cdk.CfnOutput(this, 'FunctionArn', {
      value: this.function.functionArn,
      description: `Lambda function ARN for ${id}`,
      exportName: `${config.env}-${config.projectName}-${id}-FunctionArn`,
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: this.function.functionName,
      description: `Lambda function name for ${id}`,
      exportName: `${config.env}-${config.projectName}-${id}-FunctionName`,
    });

    new cdk.CfnOutput(this, 'RoleArn', {
      value: this.role.roleArn,
      description: `Lambda execution role ARN for ${id}`,
      exportName: `${config.env}-${config.projectName}-${id}-RoleArn`,
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: this.logGroup.logGroupName,
      description: `CloudWatch Log Group for ${id}`,
      exportName: `${config.env}-${config.projectName}-${id}-LogGroupName`,
    });
  }

  /**
   * 関数のメトリクスを取得するメソッド
   */
  public metricInvocations(): cdk.aws_cloudwatch.Metric {
    return this.function.metricInvocations();
  }

  public metricErrors(): cdk.aws_cloudwatch.Metric {
    return this.function.metricErrors();
  }

  public metricDuration(): cdk.aws_cloudwatch.Metric {
    return this.function.metricDuration();
  }

  public metricThrottles(): cdk.aws_cloudwatch.Metric {
    return this.function.metricThrottles();
  }

  public metricConcurrentExecutions(): cdk.aws_cloudwatch.Metric {
    return new cdk.aws_cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'ConcurrentExecutions',
      dimensionsMap: {
        FunctionName: this.function.functionName,
      },
    });
  }
}