import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as path from 'path';
import { Construct } from 'constructs';
import { Config } from '../../common/config';
import { VpcConstruct } from '../../common/networking/vpc-construct';
import { DynamoDBConstruct } from '../../common/infrastructure/dynamodb-construct';
import { EventBridgeConstruct } from '../../common/infrastructure/eventbridge-construct';
import { SecretsConstruct } from '../../common/infrastructure/secrets-construct';
import { ApiGatewayConstruct } from '../../common/infrastructure/api-gateway-construct';
import { LambdaConstruct } from './lambda-construct';

export interface ZenginDataUpdaterStackProps extends cdk.StackProps {
  config: Config;
  vpcConstruct: VpcConstruct;
}

export class ZenginDataUpdaterStack extends cdk.Stack {
  public readonly diffTable: DynamoDBConstruct;
  public readonly auditTable: DynamoDBConstruct;
  public readonly eventBridge: EventBridgeConstruct;
  public readonly apiGateway: ApiGatewayConstruct;
  public readonly diffProcessorFunction: LambdaConstruct;
  public readonly callbackHandlerFunction: LambdaConstruct;
  public readonly diffExecutorFunction: LambdaConstruct;
  public readonly slackEventsFunction: LambdaConstruct;
  public readonly slackInteractiveFunction: LambdaConstruct;
  
  private readonly config: Config;
  private readonly diffDataBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ZenginDataUpdaterStackProps) {
    super(scope, id, props);

    const { config, vpcConstruct } = props;
    this.config = config;
    const zenginConfig = config.microservices.zenginDataUpdater;

    if (!zenginConfig.enabled) {
      return;
    }

    // DynamoDB差分テーブルを作成
    this.diffTable = this.createDiffTable(config, zenginConfig);

    // 監査ログ用DynamoDBテーブルを作成
    // 注: stg環境では既存のテーブルを使用
    if (config.env === 'stg' && zenginConfig.slack.auditTableName === 'zengin-security-audit-stg') {
      // 既存のテーブルをインポート
      const existingTable = dynamodb.Table.fromTableName(this, 'ImportedAuditTable', 'zengin-security-audit-stg');
      const construct = new Construct(this, 'AuditTable');
      (construct as any).table = existingTable;
      (construct as any).tableArn = existingTable.tableArn;
      (construct as any).tableName = existingTable.tableName;
      (construct as any).grantWriteData = (grantee: iam.IGrantable) => existingTable.grantWriteData(grantee);
      this.auditTable = construct as DynamoDBConstruct;
    } else {
      this.auditTable = this.createAuditTable(config, zenginConfig);
    }

    // S3バケットを作成（大きな差分データ用）
    this.diffDataBucket = this.createDiffDataBucket(config);

    // EventBridge & Schedulerを作成
    this.eventBridge = this.createEventBridge(config, zenginConfig);

    // Lambda関数を作成
    const { diffProcessor, callbackHandler, diffExecutor, slackEvents, slackInteractive } = this.createLambdaFunctions(
      config,
      zenginConfig,
      vpcConstruct,
      this.diffDataBucket
    );

    this.diffProcessorFunction = diffProcessor;
    this.callbackHandlerFunction = callbackHandler;
    this.diffExecutorFunction = diffExecutor;
    this.slackEventsFunction = slackEvents;
    this.slackInteractiveFunction = slackInteractive;

    // API Gateway を作成
    this.apiGateway = this.createApiGateway(config);

    // VPCネットワーク設定を適用
    vpcConstruct.configureLambdaNetworking();

    // 権限設定
    this.setupPermissions();

    // スケジュールを設定
    this.setupSchedules();

    // タグを追加
    this.addStackTags(config);

    // CloudFormation Outputs
    this.createOutputs(config);
  }

  /**
   * DynamoDB差分テーブルを作成
   */
  private createDiffTable(config: Config, zenginConfig: any): DynamoDBConstruct {
    return new DynamoDBConstruct(this, 'DiffTable', {
      config,
      tableName: zenginConfig.dynamodb.diffTableName,
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
      globalSecondaryIndexes: [
        {
          indexName: 'StatusIndex',
          partitionKey: {
            name: 'status',
            type: dynamodb.AttributeType.STRING,
          },
          sortKey: {
            name: 'timestamp',
            type: dynamodb.AttributeType.STRING,
          },
        },
      ],
      billingMode:
        zenginConfig.dynamodb.billingMode === 'PROVISIONED'
          ? dynamodb.BillingMode.PROVISIONED
          : dynamodb.BillingMode.PAY_PER_REQUEST,
      readCapacity: zenginConfig.dynamodb.readCapacity,
      writeCapacity: zenginConfig.dynamodb.writeCapacity,
      pointInTimeRecovery: zenginConfig.dynamodb.pointInTimeRecovery,
      removalPolicy:
        zenginConfig.dynamodb.removalPolicy === 'RETAIN'
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      enableTtl: true,
      ttlAttributeName: 'ttl',
    });
  }

  /**
   * 監査ログ用DynamoDBテーブルを作成またはインポート
   */
  private createAuditTable(config: Config, zenginConfig: any): DynamoDBConstruct {
    const tableName = zenginConfig.slack.auditTableName || `zengin-security-audit-${config.env}`;
    
    // 環境変数で既存テーブルの使用を制御
    const useExistingTable = process.env.USE_EXISTING_AUDIT_TABLE === 'true';
    
    if (useExistingTable) {
      // 既存のテーブルをインポート
      const existingTable = dynamodb.Table.fromTableName(this, 'ImportedAuditTable', tableName);
      
      // DynamoDBConstructのような形式で返す
      const construct = new Construct(this, 'AuditTable');
      (construct as any).table = existingTable;
      (construct as any).tableArn = existingTable.tableArn;
      (construct as any).tableName = existingTable.tableName;
      (construct as any).grantWriteData = (grantee: iam.IGrantable) => existingTable.grantWriteData(grantee);
      
      console.log(`Using existing DynamoDB table: ${tableName}`);
      return construct as DynamoDBConstruct;
    }
    
    // 新規作成
    return new DynamoDBConstruct(this, 'AuditTable', {
      config,
      tableName,
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      globalSecondaryIndexes: [
        {
          indexName: 'UserIndex',
          partitionKey: {
            name: 'user_id',
            type: dynamodb.AttributeType.STRING,
          },
          sortKey: {
            name: 'timestamp',
            type: dynamodb.AttributeType.STRING,
          },
        },
        {
          indexName: 'EventTypeIndex',
          partitionKey: {
            name: 'event_type',
            type: dynamodb.AttributeType.STRING,
          },
          sortKey: {
            name: 'timestamp',
            type: dynamodb.AttributeType.STRING,
          },
        },
      ],
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,  // 監査ログは重要なので必ず有効化
      removalPolicy: cdk.RemovalPolicy.RETAIN,  // 監査ログは削除しない
      enableTtl: true,
      ttlAttributeName: 'ttl',
    });
  }

  /**
   * S3バケットを作成（差分データ保存用）
   */
  private createDiffDataBucket(config: Config): s3.Bucket {
    const bucketName = `${config.env}-zengin-diff-data`;
    
    const bucket = new s3.Bucket(this, 'DiffDataBucket', {
      bucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeleteOldDiffs',
          enabled: true,
          expiration: cdk.Duration.days(90), // 90日後に削除
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: config.env !== 'prod',
    });

    // バケット名を出力
    new cdk.CfnOutput(this, 'DiffDataBucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket for storing large diff data',
      exportName: `${config.env}-${config.projectName}-DiffDataBucket`,
    });

    return bucket;
  }

  /**
   * EventBridge & Schedulerを作成
   */
  private createEventBridge(config: Config, zenginConfig: any): EventBridgeConstruct {
    return new EventBridgeConstruct(this, 'EventBridge', {
      config,
      schedulerGroupName: zenginConfig.eventbridge.schedulerGroupName,
    });
  }

  /**
   * API Gateway を作成
   */
  private createApiGateway(config: Config): ApiGatewayConstruct {
    const apiGateway = new ApiGatewayConstruct(this, 'SlackApi', {
      config,
      apiName: `${config.env}-zengin-slack-api`,
      description: 'API Gateway for Slack webhook endpoints',
      stage: 'v1',
      throttleRateLimit: 100,
      throttleBurstLimit: 200,
      enableCors: true,
    });

    // Add /events endpoint
    apiGateway.addLambdaIntegration({
      path: '/events',
      method: 'POST',
      function: this.slackEventsFunction.function,
      requireAuth: false,
      enableCors: false,  // CORS無効化
      requestValidation: true,
      requestParameters: {
        'method.request.header.X-Slack-Request-Timestamp': true,
        'method.request.header.X-Slack-Signature': true,
      },
    });

    // Add /interactive endpoint
    apiGateway.addLambdaIntegration({
      path: '/interactive',
      method: 'POST',
      function: this.slackInteractiveFunction.function,
      requireAuth: false,
      enableCors: false,  // CORS無効化
      requestValidation: true,
      requestParameters: {
        'method.request.header.X-Slack-Request-Timestamp': true,
        'method.request.header.X-Slack-Signature': true,
      },
    });

    // Add health check endpoint
    apiGateway.addHealthCheck();

    return apiGateway;
  }

  /**
   * Lambda関数群を作成
   */
  private createLambdaFunctions(
    config: Config,
    zenginConfig: any,
    vpcConstruct: VpcConstruct,
    diffDataBucket: s3.Bucket
  ): {
    diffProcessor: LambdaConstruct;
    callbackHandler: LambdaConstruct;
    diffExecutor: LambdaConstruct;
    slackEvents: LambdaConstruct;
    slackInteractive: LambdaConstruct;
  } {
    const vpcConfig = vpcConstruct.getLambdaVpcConfig();
    const lambdaConfig = zenginConfig.lambda;

    // psycopg2レイヤーを作成
    const psycopg2Layer = new lambda.LayerVersion(this, 'Psycopg2Layer', {
      layerVersionName: `${config.env}-psycopg2-layer`,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../layers/psycopg2')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
      description: 'psycopg2-binary layer for PostgreSQL connectivity',
    });

    // 共通環境変数
    const commonEnvironment = {
      DIFF_TABLE_NAME: this.diffTable.tableName,
      AUDIT_TABLE_NAME: this.auditTable.tableName,
      DATABASE_SECRET_ARN: config.database.secretArn,
      ENVIRONMENT: config.env,
      SLACK_BOT_TOKEN: zenginConfig.slack.botTokenSecret,
      SLACK_CHANNEL_ID: zenginConfig.slack.channelId,
      S3_BUCKET_NAME: diffDataBucket.bucketName,
      ALLOWED_SLACK_TEAM_IDS: zenginConfig.slack.allowedTeamIds?.join(',') || '',
      AUTHORIZED_USER_IDS: zenginConfig.slack.authorizedUserIds?.join(',') || '',
      // VPCエンドポイント直接参照（VPC Constructで作成されたもの、dev環境時のみ）
      // 注: Secrets Managerは既存VPCに手動作成済みのエンドポイントを使用するため削除
      // VPC_ENDPOINT_SECRETS_MANAGER: vpcConstruct.vpcEndpoints.secretsManager?.vpcEndpointId || '',
      ...(config.env === 'dev' && vpcConstruct.vpcEndpoints.cloudWatchLogs ? {
        VPC_ENDPOINT_CLOUDWATCH_LOGS: vpcConstruct.vpcEndpoints.cloudWatchLogs.vpcEndpointId,
      } : {}),
      VPC_ENDPOINT_CLOUDWATCH: vpcConstruct.vpcEndpoints.cloudWatch?.vpcEndpointId || '',
      VPC_ENDPOINT_EVENTBRIDGE: vpcConstruct.vpcEndpoints.eventBridge?.vpcEndpointId || '',
      VPC_ENDPOINT_SCHEDULER: vpcConstruct.vpcEndpoints.scheduler?.vpcEndpointId || '',
      VPC_ENDPOINT_LAMBDA: vpcConstruct.vpcEndpoints.lambda?.vpcEndpointId || '',
      // メトリクスを有効化（VPCエンドポイント経由でアクセス可能）
      ENABLE_CLOUDWATCH_METRICS: 'true',
      // AWS SDKのタイムアウト設定
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      // Slack API呼び出しの冗長化設定
      SLACK_API_TIMEOUT: '30000',  // 30秒タイムアウト
      SLACK_API_RETRY_COUNT: '3',  // 3回リトライ
      SLACK_API_RETRY_DELAY: '1000',  // 1秒間隔
      // ENI問題対策のためのウォームアップ設定
      LAMBDA_WARMUP_ENABLED: 'true',
      LAMBDA_WARMUP_INTERVAL: '300',  // 5分間隔
    };

    // 1. Diff Processor Lambda
    const diffProcessor = new LambdaConstruct(this, 'DiffProcessor', {
      config,
      functionName: `${config.env}-zengin-diff-processor`,
      description: 'Zengin data difference detection and Slack notification',
      codePath: path.join(__dirname, '../../../src/lambda/zengin-diff-processor'),
      handler: 'main.handler',
      lambdaConfig,
      vpc: vpcConfig.vpc,
      securityGroups: vpcConfig.securityGroups,
      vpcSubnets: vpcConfig.vpcSubnets,
      environment: {
        ...commonEnvironment,
      },
      layers: [psycopg2Layer],
    });

    // 2. Callback Handler Lambda
    const callbackHandler = new LambdaConstruct(this, 'CallbackHandler', {
      config,
      functionName: `${config.env}-zengin-callback-handler`,
      description: 'Slack interactive callback handler for approval/rejection',
      codePath: path.join(__dirname, '../../../src/lambda/zengin-callback-handler'),
      handler: 'main.handler',
      lambdaConfig,
      vpc: vpcConfig.vpc,
      securityGroups: vpcConfig.securityGroups,
      vpcSubnets: vpcConfig.vpcSubnets,
      environment: {
        ...commonEnvironment,
        SCHEDULER_GROUP_NAME: zenginConfig.eventbridge.schedulerGroupName,
        SLACK_SIGN_SECRET_ARN: zenginConfig.slack.signSecretArn,
        SCHEDULER_ROLE_ARN: this.eventBridge.schedulerRole.roleArn,
      },
    });

    // 3. Diff Executor Lambda
    const diffExecutor = new LambdaConstruct(this, 'DiffExecutor', {
      config,
      functionName: `${config.env}-zengin-diff-executor`,
      description: 'Execute approved zengin data differences',
      codePath: path.join(__dirname, '../../../src/lambda/zengin-diff-executor'),
      handler: 'main.handler',
      lambdaConfig,
      vpc: vpcConfig.vpc,
      securityGroups: vpcConfig.securityGroups,
      vpcSubnets: vpcConfig.vpcSubnets,
      environment: {
        ...commonEnvironment,
      },
      layers: [psycopg2Layer],
    });

    // 4. Slack Events Lambda
    const slackEvents = new LambdaConstruct(this, 'SlackEvents', {
      config,
      functionName: `${config.env}-slack-events`,
      description: 'Slack Events API endpoint handler',
      codePath: path.join(__dirname, '../../../src/lambda/slack-events'),
      handler: 'main.handler',
      lambdaConfig,
      vpc: vpcConfig.vpc,
      securityGroups: vpcConfig.securityGroups,
      vpcSubnets: vpcConfig.vpcSubnets,
      environment: {
        ...commonEnvironment,
        SLACK_SIGNING_SECRET: '', // Will be populated from Secrets Manager
      },
      reservedConcurrency: 5,  // ENI問題対策のため同時実行数を制限
    });

    // 5. Slack Interactive Lambda
    const slackInteractive = new LambdaConstruct(this, 'SlackInteractive', {
      config,
      functionName: `${config.env}-slack-interactive`,
      description: 'Slack Interactive Components endpoint handler',
      codePath: path.join(__dirname, '../../../src/lambda/slack-interactive'),
      handler: 'main.handler',
      lambdaConfig,
      vpc: vpcConfig.vpc,
      securityGroups: vpcConfig.securityGroups,
      vpcSubnets: vpcConfig.vpcSubnets,
      environment: {
        ...commonEnvironment,
        SLACK_SIGN_SECRET_ARN: zenginConfig.slack.signSecretArn,
        CALLBACK_HANDLER_FUNCTION_NAME: callbackHandler.function.functionName,
      },
      reservedConcurrency: 5,  // ENI問題対策のため同時実行数を制限
    });

    // Callback HandlerにExecutor Lambdaの参照を追加
    callbackHandler.addEnvironment('EXECUTE_LAMBDA_ARN', diffExecutor.function.functionArn);

    // Provisioned concurrency (keep warm)
    // NOTE: Provisioned concurrency is temporarily disabled due to deployment issues
    // const slackEventsAlias = slackEvents.function.currentVersion.addAlias('pc', {
    //   provisionedConcurrentExecutions: 1,
    // });
    // const slackInteractiveAlias = slackInteractive.function.currentVersion.addAlias('pc', {
    //   provisionedConcurrentExecutions: 1,
    // });

    return { diffProcessor, callbackHandler, diffExecutor, slackEvents, slackInteractive };
  }

  /**
   * 権限設定
   */
  private setupPermissions(): void {
    // DynamoDBアクセス権限
    this.diffTable.grantReadWriteData(this.diffProcessorFunction.function);
    this.diffTable.grantReadWriteData(this.callbackHandlerFunction.function);
    this.diffTable.grantReadWriteData(this.diffExecutorFunction.function); // UpdateItem権限が必要
    
    // 監査テーブルへの書き込み権限
    this.auditTable.grantWriteData(this.slackInteractiveFunction.function);
    this.auditTable.grantWriteData(this.slackEventsFunction.function);

    // S3アクセス権限
    this.diffDataBucket.grantReadWrite(this.diffProcessorFunction.function);
    this.diffDataBucket.grantRead(this.diffExecutorFunction.function);
    this.diffDataBucket.grantReadWrite(this.callbackHandlerFunction.function);

    // Secrets Manager アクセス権限
    this.grantSecretsAccess();

    // EventBridge Scheduler権限
    this.grantSchedulerAccess();

    // Lambda間の呼び出し権限
    this.diffExecutorFunction.function.grantInvoke(this.callbackHandlerFunction.function);
    this.callbackHandlerFunction.function.grantInvoke(this.slackInteractiveFunction.function);
  }

  /**
   * Secrets Manager アクセス権限を設定
   */
  private grantSecretsAccess(): void {
    const zenginConfig = this.config.microservices?.zenginDataUpdater;

    // データベースシークレットへのアクセス
    const dbSecretPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [this.config.database?.secretArn],
    });

    this.diffProcessorFunction.addToRolePolicy(dbSecretPolicy);
    this.diffExecutorFunction.addToRolePolicy(dbSecretPolicy);

    // VPC内でのAWSサービスアクセス権限（VPCエンドポイント経由）
    // 注: VPCエンドポイントは直接参照するため、Secrets Managerアクセスは不要

    // Slack Bot Token へのアクセス
    if (zenginConfig?.slack?.botTokenSecret) {
      const botTokenPolicy = new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [zenginConfig.slack.botTokenSecret],
      });

      // 全Lambdaで使用
      this.diffProcessorFunction.addToRolePolicy(botTokenPolicy);
      this.callbackHandlerFunction.addToRolePolicy(botTokenPolicy);
      this.diffExecutorFunction.addToRolePolicy(botTokenPolicy);
      this.slackEventsFunction.addToRolePolicy(botTokenPolicy);
      this.slackInteractiveFunction.addToRolePolicy(botTokenPolicy);
    }

    // Slack署名シークレットへのアクセス
    if (zenginConfig?.slack?.signSecretArn) {
      const signSecretPolicy = new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [zenginConfig.slack.signSecretArn],
      });

      this.callbackHandlerFunction.addToRolePolicy(signSecretPolicy);
      this.slackEventsFunction.addToRolePolicy(signSecretPolicy);
      this.slackInteractiveFunction.addToRolePolicy(signSecretPolicy);
    }
  }

  /**
   * EventBridge Scheduler権限を設定
   */
  private grantSchedulerAccess(): void {
    const schedulerPolicy = new iam.PolicyStatement({
      actions: [
        'scheduler:CreateSchedule',
        'scheduler:UpdateSchedule',
        'scheduler:DeleteSchedule',
        'scheduler:GetSchedule',
        'scheduler:ListSchedules',
      ],
      resources: ['*'], // スケジューラーリソースはワイルドカードが必要
    });

    this.callbackHandlerFunction.addToRolePolicy(schedulerPolicy);

    // CallbackHandler LambdaにEventBridge SchedulerロールへのPassRole権限を付与
    const passRolePolicy = new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [this.eventBridge.schedulerRole.roleArn],
      conditions: {
        StringEquals: {
          'iam:PassedToService': 'scheduler.amazonaws.com',
        },
      },
    });

    this.callbackHandlerFunction.addToRolePolicy(passRolePolicy);

    // CallbackHandler LambdaにSTS権限を付与（アカウントID取得のため）
    const stsPolicy = new iam.PolicyStatement({
      actions: ['sts:GetCallerIdentity'],
      resources: ['*'],
    });

    this.callbackHandlerFunction.addToRolePolicy(stsPolicy);

    // EventBridge Scheduler実行ロールの権限
    this.eventBridge.schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [this.diffExecutorFunction.function.functionArn],
      })
    );
  }

  /**
   * 定期実行スケジュールを設定
   */
  private setupSchedules(): void {
    const zenginConfig = this.config.microservices?.zenginDataUpdater;

    if (zenginConfig?.eventbridge?.dailyScheduleExpression) {
      this.eventBridge.addSchedule({
        scheduleName: `zengin-daily-check-${this.config.env}`,
        scheduleExpression: zenginConfig.eventbridge.dailyScheduleExpression,
        targetFunction: this.diffProcessorFunction.function,
        description: 'Daily zengin data difference check',
        inputPayload: {
          trigger: 'daily',
          source: 'eventbridge-scheduler',
        },
      });
    }
  }

  /**
   * スタック全体にタグを追加
   */
  private addStackTags(config: Config): void {
    cdk.Tags.of(this).add('Component', 'ZenginDataUpdater');
    cdk.Tags.of(this).add('Service', 'Microservice');
    cdk.Tags.of(this).add('Environment', config.env);
    cdk.Tags.of(this).add('Project', config.projectName);
  }

  /**
   * アラームと監視を設定
   */
  private setupMonitoring(config: Config): void {
    if (!config.monitoring?.enabled) {
      return;
    }

    // Lambda関数のエラーアラーム
    const functions = [
      this.diffProcessorFunction,
      this.callbackHandlerFunction,
      this.diffExecutorFunction,
    ];

    functions.forEach((lambdaConstruct) => {
      // エラー率アラーム
      const errorAlarm = lambdaConstruct.metricErrors().createAlarm(this, `${lambdaConstruct.node.id}ErrorAlarm`, {
        threshold: config.monitoring?.alerting?.errorRateThreshold || 5,
        evaluationPeriods: 2,
        alarmDescription: `Error rate too high for ${lambdaConstruct.function.functionName}`,
      });

      // 実行時間アラーム
      const durationAlarm = lambdaConstruct.metricDuration().createAlarm(this, `${lambdaConstruct.node.id}DurationAlarm`, {
        threshold: config.monitoring?.alerting?.latencyThreshold || 30000,
        evaluationPeriods: 3,
        alarmDescription: `Execution duration too high for ${lambdaConstruct.function.functionName}`,
      });

      cdk.Tags.of(errorAlarm).add('AlarmType', 'LambdaError');
      cdk.Tags.of(durationAlarm).add('AlarmType', 'LambdaDuration');
    });

    // DynamoDBアラーム
    const tableErrorAlarm = this.diffTable.metricSystemErrors().createAlarm(this, 'DiffTableSystemErrorAlarm', {
      threshold: 1,
      evaluationPeriods: 2,
      alarmDescription: 'DynamoDB system errors detected',
    });

    cdk.Tags.of(tableErrorAlarm).add('AlarmType', 'DynamoDBError');
  }

  /**
   * CloudFormation出力を作成
   */
  private createOutputs(config: Config): void {
    // API Gateway URL
    new cdk.CfnOutput(this, 'SlackApiUrl', {
      value: this.apiGateway.url,
      description: 'Slack API Gateway URL',
      exportName: `${config.env}-${config.projectName}-SlackApiUrl`,
    });

    // Slack Events Endpoint
    new cdk.CfnOutput(this, 'SlackEventsEndpoint', {
      value: `${this.apiGateway.url}events`,
      description: 'Slack Events API endpoint URL',
      exportName: `${config.env}-${config.projectName}-SlackEventsEndpoint`,
    });

    // Slack Interactive Endpoint
    new cdk.CfnOutput(this, 'SlackInteractiveEndpoint', {
      value: `${this.apiGateway.url}interactive`,
      description: 'Slack Interactive Components endpoint URL',
      exportName: `${config.env}-${config.projectName}-SlackInteractiveEndpoint`,
    });

    // DynamoDB Table Name
    new cdk.CfnOutput(this, 'DiffTableName', {
      value: this.diffTable.tableName,
      description: 'DynamoDB diff table name',
      exportName: `${config.env}-${config.projectName}-DiffTableName`,
    });

    // Lambda Function ARNs
    new cdk.CfnOutput(this, 'DiffProcessorFunctionArn', {
      value: this.diffProcessorFunction.function.functionArn,
      description: 'Diff processor Lambda function ARN',
      exportName: `${config.env}-${config.projectName}-DiffProcessorFunctionArn`,
    });

    new cdk.CfnOutput(this, 'CallbackHandlerFunctionArn', {
      value: this.callbackHandlerFunction.function.functionArn,
      description: 'Callback handler Lambda function ARN',
      exportName: `${config.env}-${config.projectName}-CallbackHandlerFunctionArn`,
    });
  }
}