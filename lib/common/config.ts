import * as fs from 'fs';
import * as path from 'path';

// 基本設定の型定義
export interface Config {
  env: string;
  projectName: string;
  account: string;
  region: string;
  profile?: string;
  tags: Record<string, string>;
  vpc: VpcConfig;
  vpcEndpoints?: VpcEndpointsConfig;
  database: DatabaseConfig;
  microservices: MicroservicesConfig;
  monitoring?: MonitoringConfig;
  costOptimization?: CostOptimizationConfig;
}

export interface VpcConfig {
  vpcId: string;
  privateSubnetIds: string[];
  publicSubnetIds: string[];
}

export interface VpcEndpointsConfig {
  secretArn: string;
}

export interface DatabaseConfig {
  secretArn: string;
  host: string;
  port: number;
  name: string;
}

export interface MicroservicesConfig {
  zenginDataUpdater: ZenginDataUpdaterConfig;
}

export interface ZenginDataUpdaterConfig {
  enabled: boolean;
  lambda: LambdaConfig;
  dynamodb: DynamoDbConfig;
  eventbridge: EventBridgeConfig;
  slack: SlackConfig;
}

export interface LambdaConfig {
  runtime: string;
  timeout: number;
  memorySize: number;
  logRetentionDays: number;
  environment?: Record<string, string>;
}

export interface DynamoDbConfig {
  diffTableName: string;
  billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED';
  pointInTimeRecovery: boolean;
  removalPolicy: 'DESTROY' | 'RETAIN';
  readCapacity?: number;
  writeCapacity?: number;
}

export interface EventBridgeConfig {
  dailyScheduleExpression: string;
  schedulerGroupName: string;
}

export interface SlackConfig {
  webhookSecretArn: string;
  signSecretArn: string;
  botTokenSecret?: string;
  channelId?: string;
  allowedTeamIds?: string[];
  authorizedUserIds?: string[];
  auditTableName?: string;
}

export interface MonitoringConfig {
  enabled: boolean;
  slackNotificationArn?: string;
  cloudWatchDashboard?: boolean;
  alerting?: AlertingConfig;
}

export interface AlertingConfig {
  errorRateThreshold: number;
  latencyThreshold: number;
}

export interface CostOptimizationConfig {
  autoScaling: AutoScalingConfig;
  enableSpotInstances: boolean;
  cloudWatchMetricsEnabled: boolean;
  reservedCapacity?: boolean;
}

export interface AutoScalingConfig {
  minCapacity: number;
  maxCapacity: number;
}

/**
 * 設定管理クラス
 */
export class ConfigLoader {
  private static configCache: Map<string, Config> = new Map();

  /**
   * 指定された環境の設定を取得
   * @param env 環境名 (dev, stg, prod)
   * @returns 設定オブジェクト
   */
  public static getConfig(env: string): Config {
    // キャッシュから取得
    if (this.configCache.has(env)) {
      return this.configCache.get(env)!;
    }

    // 設定ファイルを読み込み
    const config = this.loadConfig(env);

    // バリデーション
    this.validateConfig(config);

    // キャッシュに保存
    this.configCache.set(env, config);

    return config;
  }

  /**
   * 設定ファイルを読み込み
   * @param env 環境名
   * @returns 設定オブジェクト
   */
  private static loadConfig(env: string): Config {
    const configDir = path.join(__dirname, '../../config');
    const configPath = path.join(configDir, `${env}.json`);

    if (!fs.existsSync(configPath)) {
      throw new Error(`設定ファイルが見つかりません: ${configPath}`);
    }

    try {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configContent) as Config;

      // デフォルト値を設定
      return this.setDefaults(config, env);
    } catch (error) {
      throw new Error(`設定ファイルの読み込みに失敗しました: ${configPath}: ${error}`);
    }
  }

  /**
   * デフォルト値を設定
   * @param config 設定オブジェクト
   * @param env 環境名
   * @returns デフォルト値が設定された設定オブジェクト
   */
  private static setDefaults(config: Config, env: string): Config {
    const defaultConfig: Partial<Config> = {
      env,
      tags: {
        Project: config.projectName || 'AdvasaBusinessBase',
        Environment: env,
        ManagedBy: 'CDK',
        ...config.tags,
      },
      monitoring: {
        enabled: env === 'prod',
        cloudWatchDashboard: env === 'prod',
        alerting: {
          errorRateThreshold: 5,
          latencyThreshold: 30000,
        },
        ...config.monitoring,
      },
      costOptimization: {
        autoScaling: {
          minCapacity: 0,
          maxCapacity: env === 'prod' ? 10 : 2,
        },
        enableSpotInstances: false,
        cloudWatchMetricsEnabled: true,
        reservedCapacity: env === 'prod',
        ...config.costOptimization,
      },
    };

    // Zengin Data Updater のデフォルト値
    if (config.microservices?.zenginDataUpdater) {
      const zenginDefaults: Partial<ZenginDataUpdaterConfig> = {
        lambda: {
          ...config.microservices.zenginDataUpdater.lambda,
          runtime: config.microservices.zenginDataUpdater.lambda?.runtime || 'python3.11',
          timeout: config.microservices.zenginDataUpdater.lambda?.timeout || 600, // ENI初期化時間を考慮して10分に延長
          memorySize: config.microservices.zenginDataUpdater.lambda?.memorySize || 1024, // ENI問題軽減のためメモリ増量
          logRetentionDays: config.microservices.zenginDataUpdater.lambda?.logRetentionDays || (env === 'prod' ? 30 : 14),
          environment: {
            LOG_LEVEL: env === 'prod' ? 'INFO' : 'DEBUG',
            ENVIRONMENT: env,
            ...config.microservices.zenginDataUpdater.lambda?.environment,
          },
        },
        dynamodb: {
          ...config.microservices.zenginDataUpdater.dynamodb,
          diffTableName: config.microservices.zenginDataUpdater.dynamodb?.diffTableName || `zengin-data-diff-${env}`,
          billingMode: config.microservices.zenginDataUpdater.dynamodb?.billingMode || 'PAY_PER_REQUEST',
          pointInTimeRecovery: config.microservices.zenginDataUpdater.dynamodb?.pointInTimeRecovery ?? (env === 'prod'),
          removalPolicy: config.microservices.zenginDataUpdater.dynamodb?.removalPolicy || (env === 'prod' ? 'RETAIN' : 'DESTROY'),
        },
        eventbridge: {
          ...config.microservices.zenginDataUpdater.eventbridge,
          dailyScheduleExpression: config.microservices.zenginDataUpdater.eventbridge?.dailyScheduleExpression || (env === 'prod' ? 'cron(0 23 * * ? *)' : 'cron(0 9 * * ? *)'),
          schedulerGroupName: config.microservices.zenginDataUpdater.eventbridge?.schedulerGroupName || `zengin-data-updater-${env}`,
        },
      };

      config.microservices.zenginDataUpdater = {
        ...zenginDefaults,
        ...config.microservices.zenginDataUpdater,
      } as ZenginDataUpdaterConfig;
    }

    return {
      ...defaultConfig,
      ...config,
    } as Config;
  }

  /**
   * 設定の妥当性を検証
   * @param config 設定オブジェクト
   */
  private static validateConfig(config: Config): void {
    const errors: string[] = [];

    // 必須フィールドの検証
    if (!config.env) {
      errors.push('env は必須です');
    }

    if (!config.projectName) {
      errors.push('projectName は必須です');
    }

    if (!config.account) {
      errors.push('account は必須です');
    }

    if (!config.region) {
      errors.push('region は必須です');
    }

    // AWSアカウントIDの形式検証
    if (config.account && !/^\d{12}$/.test(config.account)) {
      errors.push('account は12桁の数字である必要があります');
    }

    // VPC設定の検証
    if (!config.vpc?.vpcId) {
      errors.push('vpc.vpcId は必須です');
    }

    if (!config.vpc?.privateSubnetIds || config.vpc.privateSubnetIds.length === 0) {
      errors.push('vpc.privateSubnetIds は必須で、少なくとも1つのサブネットが必要です');
    }

    // データベース設定の検証
    if (!config.database?.secretArn) {
      errors.push('database.secretArn は必須です');
    }

    if (!config.database?.host) {
      errors.push('database.host は必須です');
    }

    // Zengin Data Updater設定の検証
    if (config.microservices?.zenginDataUpdater?.enabled) {
      const zenginConfig = config.microservices.zenginDataUpdater;

      if (!zenginConfig.slack?.signSecretArn) {
        errors.push('microservices.zenginDataUpdater.slack.signSecretArn は必須です');
      }

      // Lambda設定の検証
      if (zenginConfig.lambda?.timeout && (zenginConfig.lambda.timeout < 1 || zenginConfig.lambda.timeout > 900)) {
        errors.push('microservices.zenginDataUpdater.lambda.timeout は1-900秒の範囲で指定してください');
      }

      if (zenginConfig.lambda?.memorySize && (zenginConfig.lambda.memorySize < 128 || zenginConfig.lambda.memorySize > 10240)) {
        errors.push('microservices.zenginDataUpdater.lambda.memorySize は128-10240MBの範囲で指定してください');
      }
    }

    // エラーがある場合は例外を投げる
    if (errors.length > 0) {
      throw new Error(`設定検証エラー:\n${errors.join('\n')}`);
    }
  }

  /**
   * キャッシュをクリア
   */
  public static clearCache(): void {
    this.configCache.clear();
  }

  /**
   * 設定の一覧を取得（デバッグ用）
   * @returns 設定の一覧
   */
  public static listConfigs(): string[] {
    const configDir = path.join(__dirname, '../../config');
    if (!fs.existsSync(configDir)) {
      return [];
    }

    return fs.readdirSync(configDir)
      .filter(file => file.endsWith('.json'))
      .map(file => path.basename(file, '.json'));
  }
}

// 環境変数から設定を取得するヘルパー関数
export function getConfigFromEnv(): Config {
  const env = process.env.CDK_ENV || process.env.NODE_ENV || 'dev';
  return ConfigLoader.getConfig(env);
}

// よく使用される設定値を取得するヘルパー関数
export function getResourceName(config: Config, resourceType: string, resourceName: string): string {
  return `${config.env}-${config.projectName}-${resourceType}-${resourceName}`;
}

export function getTableName(config: Config, tableName: string): string {
  return `${tableName}-${config.env}`;
}

export function getLambdaFunctionName(config: Config, functionName: string): string {
  return `${config.env}-${functionName}`;
}