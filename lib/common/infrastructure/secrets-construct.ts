import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { Config } from '../config';

export interface SecretsConstructProps {
  config: Config;
  secretName: string;
  description?: string;
  generateSecretString?: secretsmanager.SecretStringGenerator;
  secretValue?: cdk.SecretValue;
  replicationRegions?: secretsmanager.ReplicaRegion[];
  removalPolicy?: cdk.RemovalPolicy;
}

export class SecretsConstruct extends Construct {
  public readonly secret: secretsmanager.Secret;
  public readonly secretArn: string;
  public readonly secretName: string;

  constructor(scope: Construct, id: string, props: SecretsConstructProps) {
    super(scope, id);

    const {
      config,
      secretName,
      description,
      generateSecretString,
      secretValue,
      replicationRegions = [],
      removalPolicy = cdk.RemovalPolicy.RETAIN,
    } = props;

    // Secrets Manager シークレットを作成
    const secretProps: secretsmanager.SecretProps = {
      secretName,
      description: description || `Secret for ${secretName}`,
      removalPolicy,
      // 自動生成またはカスタム値を設定
      ...(generateSecretString && { generateSecretString }),
      ...(secretValue && { secretStringValue: secretValue }),
      // レプリケーション設定
      ...(replicationRegions.length > 0 && { replicaRegions: replicationRegions }),
    };

    this.secret = new secretsmanager.Secret(this, 'Secret', secretProps);

    // プロパティを設定
    this.secretArn = this.secret.secretArn;
    this.secretName = this.secret.secretName;

    // タグを追加
    cdk.Tags.of(this.secret).add('Component', 'SecretsManager');
    cdk.Tags.of(this.secret).add('Service', 'SecretStorage');

    // CloudFormation出力
    new cdk.CfnOutput(this, 'SecretArn', {
      value: this.secretArn,
      description: `ARN of the ${secretName} secret`,
      exportName: `${config.env}-${config.projectName}-${id}-SecretArn`,
    });

    new cdk.CfnOutput(this, 'SecretName', {
      value: this.secretName,
      description: `Name of the ${secretName} secret`,
      exportName: `${config.env}-${config.projectName}-${id}-SecretName`,
    });
  }

  /**
   * Lambda関数にこのシークレットの読み取り権限を付与
   * @param lambdaFunction Lambda関数
   */
  public grantRead(lambdaFunction: lambda.Function): iam.Grant {
    return this.secret.grantRead(lambdaFunction);
  }

  /**
   * Lambda関数にこのシークレットの書き込み権限を付与
   * @param lambdaFunction Lambda関数
   */
  public grantWrite(lambdaFunction: lambda.Function): iam.Grant {
    return this.secret.grantWrite(lambdaFunction);
  }

  /**
   * Lambda関数にこのシークレットの読み書き権限を付与
   * @param lambdaFunction Lambda関数
   */
  public grantReadWrite(lambdaFunction: lambda.Function): iam.Grant {
    // CDK v2ではgrantReadWriteが存在しないため、読み取りと書き込みを組み合わせる
    this.secret.grantRead(lambdaFunction);
    return this.secret.grantWrite(lambdaFunction);
  }

  /**
   * IAMロールまたはユーザーに読み取り権限を付与
   * @param grantee 権限を付与する対象
   */
  public grantReadToRole(grantee: iam.IGrantable): iam.Grant {
    return this.secret.grantRead(grantee);
  }

  /**
   * シークレットの値を他のリソースで参照する際のヘルパーメソッド
   * @param jsonField JSONキー（JSON形式のシークレットの場合）
   */
  public secretValueFromJson(jsonField: string): cdk.SecretValue {
    return this.secret.secretValueFromJson(jsonField);
  }

  /**
   * シークレット全体の値を取得
   */
  public get secretValue(): cdk.SecretValue {
    return this.secret.secretValue;
  }

  /**
   * 自動ローテーション機能を追加
   * @param rotationLambda ローテーション用Lambda関数
   * @param automaticallyAfter ローテーション間隔
   */
  public addRotationSchedule(
    rotationLambda: lambda.Function,
    automaticallyAfter?: cdk.Duration
  ): secretsmanager.RotationSchedule {
    return this.secret.addRotationSchedule('RotationSchedule', {
      rotationLambda,
      automaticallyAfter: automaticallyAfter || cdk.Duration.days(30),
    });
  }

  /**
   * シークレットのバージョン管理ヘルパー
   */
  public addToResourcePolicy(statement: iam.PolicyStatement): void {
    this.secret.addToResourcePolicy(statement);
  }

  /**
   * クロスアカウントアクセス用のリソースポリシーを追加
   * @param accountIds 許可するアカウントIDのリスト
   * @param actions 許可するアクション
   */
  public allowCrossAccountAccess(accountIds: string[], actions: string[] = ['secretsmanager:GetSecretValue']): void {
    const statement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: accountIds.map(accountId => new iam.AccountPrincipal(accountId)),
      actions,
      resources: [this.secretArn],
    });

    this.addToResourcePolicy(statement);
  }

  /**
   * 特定のIAMロールにアクセス権限を付与
   * @param roleArn ロールのARN
   * @param actions 許可するアクション
   */
  public allowRoleAccess(roleArn: string, actions: string[] = ['secretsmanager:GetSecretValue']): void {
    const statement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [iam.Role.fromRoleArn(this, 'ExternalRole', roleArn)],
      actions,
      resources: [this.secretArn],
    });

    this.addToResourcePolicy(statement);
  }
}

/**
 * よく使用されるシークレットタイプのヘルパークラス
 */
export class DatabaseSecret extends SecretsConstruct {
  constructor(scope: Construct, id: string, config: Config, dbIdentifier: string) {
    super(scope, id, {
      config,
      secretName: `${config.env}-${config.projectName}-database-${dbIdentifier}`,
      description: `Database credentials for ${dbIdentifier} in ${config.env} environment`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'admin',
          host: config.database.host,
          port: config.database.port,
          database: config.database.name,
        }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\\'',
        passwordLength: 32,
      },
      removalPolicy: config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }
}

export class SlackSecret extends SecretsConstruct {
  constructor(scope: Construct, id: string, config: Config, secretType: 'webhook' | 'signing') {
    const secretName = `${config.env}-${config.projectName}-slack-${secretType}`;
    const description = `Slack ${secretType} secret for ${config.env} environment`;

    super(scope, id, {
      config,
      secretName,
      description,
      removalPolicy: config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }
}

export class ApiKeySecret extends SecretsConstruct {
  constructor(scope: Construct, id: string, config: Config, serviceName: string) {
    super(scope, id, {
      config,
      secretName: `${config.env}-${config.projectName}-api-key-${serviceName}`,
      description: `API key for ${serviceName} in ${config.env} environment`,
      generateSecretString: {
        generateStringKey: 'apiKey',
        secretStringTemplate: JSON.stringify({ service: serviceName }),
        excludeCharacters: '"@/\\\'',
        passwordLength: 64,
      },
      removalPolicy: config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }
}