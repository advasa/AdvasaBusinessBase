import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Config } from '../config';

export interface DynamoDBConstructProps {
  config: Config;
  tableName: string;
  partitionKey: dynamodb.Attribute;
  sortKey?: dynamodb.Attribute;
  globalSecondaryIndexes?: dynamodb.GlobalSecondaryIndexProps[];
  localSecondaryIndexes?: dynamodb.LocalSecondaryIndexProps[];
  billingMode?: dynamodb.BillingMode;
  readCapacity?: number;
  writeCapacity?: number;
  pointInTimeRecovery?: boolean;
  removalPolicy?: cdk.RemovalPolicy;
  enableTtl?: boolean;
  ttlAttributeName?: string;
}

export class DynamoDBConstruct extends Construct {
  public readonly table: dynamodb.Table;
  public readonly tableArn: string;
  public readonly tableName: string;

  constructor(scope: Construct, id: string, props: DynamoDBConstructProps) {
    super(scope, id);

    const {
      config,
      tableName,
      partitionKey,
      sortKey,
      globalSecondaryIndexes = [],
      localSecondaryIndexes = [],
      billingMode = dynamodb.BillingMode.PAY_PER_REQUEST,
      readCapacity,
      writeCapacity,
      pointInTimeRecovery = false,
      removalPolicy = cdk.RemovalPolicy.DESTROY,
      enableTtl = false,
      ttlAttributeName = 'ttl',
    } = props;

    // DynamoDB テーブルを作成
    const tableProps: dynamodb.TableProps = {
      tableName,
      partitionKey,
      sortKey,
      billingMode,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: pointInTimeRecovery,
      },
      removalPolicy,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: config.env === 'prod',
      // プロビジョニング済みモードの場合の容量設定
      ...(billingMode === dynamodb.BillingMode.PROVISIONED && readCapacity && {
        readCapacity,
      }),
      ...(billingMode === dynamodb.BillingMode.PROVISIONED && writeCapacity && {
        writeCapacity,
      }),
    };

    this.table = new dynamodb.Table(this, 'Table', tableProps);

    // TTLを有効化
    if (enableTtl) {
      new cdk.CfnOutput(this, 'TTLConfig', {
        value: `TTL enabled on attribute: ${ttlAttributeName}`,
        description: 'TTL configuration for the table',
      });
    }

    // Global Secondary Indexes を追加
    globalSecondaryIndexes.forEach((gsiProps, index) => {
      this.table.addGlobalSecondaryIndex({
        ...gsiProps,
        indexName: gsiProps.indexName || `GSI${index + 1}`,
      });
    });

    // Local Secondary Indexes を追加
    localSecondaryIndexes.forEach((lsiProps, index) => {
      this.table.addLocalSecondaryIndex({
        ...lsiProps,
        indexName: lsiProps.indexName || `LSI${index + 1}`,
      });
    });

    // プロパティを設定
    this.tableArn = this.table.tableArn;
    this.tableName = this.table.tableName;

    // タグを追加
    cdk.Tags.of(this.table).add('Component', 'DynamoDB');
    cdk.Tags.of(this.table).add('Service', 'DataStorage');

    // CloudFormation出力
    new cdk.CfnOutput(this, 'TableName', {
      value: this.tableName,
      description: 'DynamoDB table name',
      exportName: `${config.env}-${config.projectName}-${id}-TableName`,
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value: this.tableArn,
      description: 'DynamoDB table ARN',
      exportName: `${config.env}-${config.projectName}-${id}-TableArn`,
    });
  }

  /**
   * Lambda関数にこのテーブルへの読み取り権限を付与
   * @param lambdaFunction Lambda関数
   */
  public grantReadData(lambdaFunction: iam.IGrantable): iam.Grant {
    return this.table.grantReadData(lambdaFunction);
  }

  /**
   * Lambda関数にこのテーブルへの書き込み権限を付与
   * @param lambdaFunction Lambda関数
   */
  public grantWriteData(lambdaFunction: iam.IGrantable): iam.Grant {
    return this.table.grantWriteData(lambdaFunction);
  }

  /**
   * Lambda関数にこのテーブルへの読み書き権限を付与
   * @param lambdaFunction Lambda関数
   */
  public grantReadWriteData(lambdaFunction: iam.IGrantable): iam.Grant {
    return this.table.grantReadWriteData(lambdaFunction);
  }

  /**
   * Lambda関数にこのテーブルのストリーム読み取り権限を付与
   * @param lambdaFunction Lambda関数
   */
  public grantStreamRead(lambdaFunction: iam.IGrantable): iam.Grant {
    return this.table.grantStreamRead(lambdaFunction);
  }

  /**
   * テーブルのメトリクスを取得するメソッド
   */
  public metricConsumedReadCapacityUnits(): cdk.aws_cloudwatch.Metric {
    return this.table.metricConsumedReadCapacityUnits();
  }

  public metricConsumedWriteCapacityUnits(): cdk.aws_cloudwatch.Metric {
    return this.table.metricConsumedWriteCapacityUnits();
  }

  public metricUserErrors(): cdk.aws_cloudwatch.Metric {
    return this.table.metricUserErrors();
  }

  public metricSystemErrors(): cdk.aws_cloudwatch.Metric {
    return this.table.metricSystemErrors();
  }

  public metricThrottledRequests(): cdk.aws_cloudwatch.Metric {
    return this.table.metricThrottledRequests();
  }
}