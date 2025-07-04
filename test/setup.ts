import 'jest';

// Jest setup for CDK testing
process.env.NODE_ENV = 'test';
process.env.CDK_ENV = 'test';

// Mock AWS SDK calls by default
jest.mock('aws-sdk', () => ({
  config: {
    update: jest.fn(),
  },
  CloudFormation: jest.fn(() => ({
    describeStacks: jest.fn(() => ({
      promise: jest.fn(() => Promise.resolve({ Stacks: [] })),
    })),
  })),
  DynamoDB: jest.fn(() => ({
    describeTable: jest.fn(() => ({
      promise: jest.fn(() => Promise.resolve({})),
    })),
  })),
  Lambda: jest.fn(() => ({
    getFunction: jest.fn(() => ({
      promise: jest.fn(() => Promise.resolve({})),
    })),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn(() => ({
      promise: jest.fn(() => Promise.resolve({
        SecretString: JSON.stringify({
          username: 'test_user',
          password: 'test_password',
          host: 'test-host',
          port: 5432,
          database: 'test_db',
        }),
      })),
    })),
  })),
}));

// Set longer timeout for CDK operations
jest.setTimeout(30000);

// Global test configuration
global.testConfig = {
  env: 'test',
  projectName: 'AdvasaBusinessBase',
  account: '123456789012',
  region: 'ap-northeast-1',
  tags: {
    Project: 'AdvasaBusinessBase',
    Environment: 'test',
    ManagedBy: 'CDK',
  },
  vpc: {
    vpcId: 'vpc-12345678',
    privateSubnetIds: ['subnet-private-1a', 'subnet-private-1c'],
    publicSubnetIds: ['subnet-public-1a', 'subnet-public-1c'],
  },
  database: {
    secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:test-db-secret',
    host: 'test-db-host.amazonaws.com',
    port: 5432,
    name: 'test_database',
  },
  microservices: {
    zenginDataUpdater: {
      enabled: true,
      lambda: {
        runtime: 'python3.11',
        timeout: 300,
        memorySize: 512,
        logRetentionDays: 14,
        environment: {
          LOG_LEVEL: 'DEBUG',
          ENVIRONMENT: 'test',
        },
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
        webhookSecretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:slack-webhook-test',
        signSecretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:slack-signing-test',
      },
    },
  },
  monitoring: {
    enabled: false,
  },
  costOptimization: {
    autoScaling: {
      minCapacity: 0,
      maxCapacity: 1,
    },
    enableSpotInstances: false,
    cloudWatchMetricsEnabled: false,
  },
};

// Helper function to create test app
export function createTestApp() {
  const { App } = require('aws-cdk-lib');
  return new App({
    context: {
      env: 'test',
      config: global.testConfig,
    },
  });
}

// Helper function to get template from stack
export function getTemplate(stack: any) {
  const { Template } = require('aws-cdk-lib/assertions');
  return Template.fromStack(stack);
}

// Custom matchers for CDK assertions
expect.extend({
  toHaveResource(template: any, resourceType: string, properties?: any) {
    const resources = template.findResources(resourceType, properties);
    const pass = Object.keys(resources).length > 0;
    
    if (pass) {
      return {
        message: () => `Expected template not to have resource ${resourceType}`,
        pass: true,
      };
    } else {
      return {
        message: () => `Expected template to have resource ${resourceType}`,
        pass: false,
      };
    }
  },
  
  toHaveResourceWithProperties(template: any, resourceType: string, properties: any) {
    const resources = template.findResources(resourceType, properties);
    const pass = Object.keys(resources).length > 0;
    
    if (pass) {
      return {
        message: () => `Expected template not to have resource ${resourceType} with properties ${JSON.stringify(properties)}`,
        pass: true,
      };
    } else {
      return {
        message: () => `Expected template to have resource ${resourceType} with properties ${JSON.stringify(properties)}`,
        pass: false,
      };
    }
  },
});

// Declare global types for TypeScript
declare global {
  var testConfig: any;
  
  namespace jest {
    interface Matchers<R> {
      toHaveResource(resourceType: string, properties?: any): R;
      toHaveResourceWithProperties(resourceType: string, properties: any): R;
    }
  }
}