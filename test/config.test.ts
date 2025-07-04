import { ConfigLoader, Config } from '../lib/common/config';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs module
jest.mock('fs');

describe('ConfigLoader', () => {
  const mockFs = fs as jest.Mocked<typeof fs>;

  beforeEach(() => {
    // Clear the cache before each test
    ConfigLoader.clearCache();
    jest.clearAllMocks();
  });

  describe('getConfig', () => {
    const mockConfigContent = {
      env: 'test',
      projectName: 'AdvasaBusinessBase',
      account: '123456789012',
      region: 'ap-northeast-1',
      tags: {
        Project: 'AdvasaBusinessBase',
        Environment: 'test',
      },
      vpc: {
        vpcId: 'vpc-12345678',
        privateSubnetIds: ['subnet-private-1a'],
        publicSubnetIds: ['subnet-public-1a'],
      },
      database: {
        secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:test-db',
        host: 'test-host',
        port: 5432,
        name: 'test_db',
      },
      microservices: {
        zenginDataUpdater: {
          enabled: true,
          lambda: {
            runtime: 'python3.11',
            timeout: 300,
            memorySize: 512,
            logRetentionDays: 14,
          },
          dynamodb: {
            diffTableName: 'zengin-data-diff-test',
            billingMode: 'PAY_PER_REQUEST',
            pointInTimeRecovery: false,
            removalPolicy: 'DESTROY',
          },
          eventbridge: {
            dailyScheduleExpression: 'cron(0 9 * * ? *)',
            schedulerGroupName: 'zengin-data-updater-test',
          },
          slack: {
            webhookSecretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:slack-webhook',
            signSecretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:slack-sign',
          },
        },
      },
    };

    it('should load and validate configuration successfully', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockConfigContent));

      const config = ConfigLoader.getConfig('test');

      expect(config).toBeDefined();
      expect(config.env).toBe('test');
      expect(config.projectName).toBe('AdvasaBusinessBase');
      expect(config.account).toBe('123456789012');
      expect(config.region).toBe('ap-northeast-1');
    });

    it('should apply default values correctly', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockConfigContent));

      const config = ConfigLoader.getConfig('test');

      expect(config.tags).toHaveProperty('ManagedBy', 'CDK');
      expect(config.microservices.zenginDataUpdater.lambda.environment).toHaveProperty('ENVIRONMENT', 'test');
      expect(config.monitoring).toBeDefined();
      expect(config.costOptimization).toBeDefined();
    });

    it('should throw error if configuration file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => {
        ConfigLoader.getConfig('nonexistent');
      }).toThrow('設定ファイルが見つかりません');
    });

    it('should throw error for invalid JSON content', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      expect(() => {
        ConfigLoader.getConfig('test');
      }).toThrow('設定ファイルの読み込みに失敗しました');
    });

    it('should cache configuration after first load', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockConfigContent));

      // First call
      const config1 = ConfigLoader.getConfig('test');
      
      // Second call
      const config2 = ConfigLoader.getConfig('test');

      expect(config1).toBe(config2);
      expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation', () => {
    it('should validate required fields', () => {
      const invalidConfig = {
        // Missing required fields
        env: '',
        projectName: '',
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidConfig));

      expect(() => {
        ConfigLoader.getConfig('test');
      }).toThrow('設定検証エラー');
    });

    it('should validate AWS account ID format', () => {
      const invalidConfig = {
        ...global.testConfig,
        account: 'invalid-account-id',
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidConfig));

      expect(() => {
        ConfigLoader.getConfig('test');
      }).toThrow('account は12桁の数字である必要があります');
    });

    it('should validate VPC configuration', () => {
      const invalidConfig = {
        ...global.testConfig,
        vpc: {
          vpcId: '',
          privateSubnetIds: [],
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidConfig));

      expect(() => {
        ConfigLoader.getConfig('test');
      }).toThrow('設定検証エラー');
    });

    it('should validate Lambda timeout range', () => {
      const invalidConfig = {
        ...global.testConfig,
        microservices: {
          zenginDataUpdater: {
            ...global.testConfig.microservices.zenginDataUpdater,
            lambda: {
              ...global.testConfig.microservices.zenginDataUpdater.lambda,
              timeout: 1000, // Invalid: max is 900
            },
          },
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidConfig));

      expect(() => {
        ConfigLoader.getConfig('test');
      }).toThrow('timeout は1-900秒の範囲で指定してください');
    });
  });

  describe('listConfigs', () => {
    it('should return list of available configuration files', () => {
      const configDir = path.join(__dirname, '../config');
      
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['dev.json', 'stg.json', 'prod.json', 'other.txt'] as any);

      const configs = ConfigLoader.listConfigs();

      expect(configs).toEqual(['dev', 'stg', 'prod']);
    });

    it('should return empty array if config directory does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const configs = ConfigLoader.listConfigs();

      expect(configs).toEqual([]);
    });
  });

  describe('environment-specific defaults', () => {
    it('should set production-specific defaults', () => {
      const prodConfig = {
        ...global.testConfig,
        env: 'prod',
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(prodConfig));

      const config = ConfigLoader.getConfig('prod');

      expect(config.monitoring?.enabled).toBe(true);
      expect(config.monitoring?.cloudWatchDashboard).toBe(true);
      expect(config.costOptimization?.reservedCapacity).toBe(true);
      expect(config.microservices.zenginDataUpdater.lambda.logRetentionDays).toBe(30);
      expect(config.microservices.zenginDataUpdater.lambda.environment?.LOG_LEVEL).toBe('INFO');
    });

    it('should set development-specific defaults', () => {
      const devConfig = {
        ...global.testConfig,
        env: 'dev',
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(devConfig));

      const config = ConfigLoader.getConfig('dev');

      expect(config.monitoring?.enabled).toBe(false);
      expect(config.costOptimization?.autoScaling.maxCapacity).toBe(2);
      expect(config.microservices.zenginDataUpdater.lambda.environment?.LOG_LEVEL).toBe('DEBUG');
    });
  });
});