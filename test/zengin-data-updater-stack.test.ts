import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ZenginDataUpdaterStack } from '../lib/microservices/zengin-data-updater/zengin-data-updater-stack';
import { VpcConstruct } from '../lib/common/networking/vpc-construct';
import { createTestApp, getTemplate } from './setup';

describe('ZenginDataUpdaterStack', () => {
  let app: cdk.App;
  let vpcConstruct: VpcConstruct;
  let stack: ZenginDataUpdaterStack;
  let template: any;

  beforeEach(() => {
    app = createTestApp();
    
    // Create VPC construct
    vpcConstruct = new VpcConstruct(app, 'TestVpc', {
      config: global.testConfig,
      env: {
        account: global.testConfig.account,
        region: global.testConfig.region,
      },
    });

    // Create ZenginDataUpdaterStack
    stack = new ZenginDataUpdaterStack(app, 'TestZenginDataUpdaterStack', {
      config: global.testConfig,
      vpcConstruct,
      env: {
        account: global.testConfig.account,
        region: global.testConfig.region,
      },
    });

    template = getTemplate(stack);
  });

  describe('DynamoDB Table', () => {
    it('should create DynamoDB table with correct configuration', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'zengin-data-diff-test',
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          {
            AttributeName: 'id',
            AttributeType: 'S',
          },
          {
            AttributeName: 'timestamp',
            AttributeType: 'S',
          },
          {
            AttributeName: 'status',
            AttributeType: 'S',
          },
        ],
        KeySchema: [
          {
            AttributeName: 'id',
            KeyType: 'HASH',
          },
          {
            AttributeName: 'timestamp',
            KeyType: 'RANGE',
          },
        ],
      });
    });

    it('should create Global Secondary Index for status queries', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        GlobalSecondaryIndexes: [
          {
            IndexName: 'StatusIndex',
            KeySchema: [
              {
                AttributeName: 'status',
                KeyType: 'HASH',
              },
              {
                AttributeName: 'timestamp',
                KeyType: 'RANGE',
              },
            ],
            Projection: {
              ProjectionType: 'ALL',
            },
          },
        ],
      });
    });

    it('should have TTL enabled', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TimeToLiveSpecification: {
          AttributeName: 'ttl',
          Enabled: true,
        },
      });
    });
  });

  describe('Lambda Functions', () => {
    it('should create diff processor Lambda function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-zengin-diff-processor',
        Runtime: 'python3.11',
        Handler: 'main.handler',
        Timeout: 300,
        MemorySize: 512,
      });
    });

    it('should create callback handler Lambda function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-zengin-callback-handler',
        Runtime: 'python3.11',
        Handler: 'main.handler',
        Timeout: 300,
        MemorySize: 512,
      });
    });

    it('should create diff executor Lambda function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-zengin-diff-executor',
        Runtime: 'python3.11',
        Handler: 'main.handler',
        Timeout: 300,
        MemorySize: 512,
      });
    });

    it('should configure Lambda functions with VPC settings', () => {
      const lambdaFunctions = template.findResources('AWS::Lambda::Function');
      
      Object.values(lambdaFunctions).forEach((func: any) => {
        expect(func.Properties).toHaveProperty('VpcConfig');
        expect(func.Properties.VpcConfig).toHaveProperty('SecurityGroupIds');
        expect(func.Properties.VpcConfig).toHaveProperty('SubnetIds');
      });
    });

    it('should set correct environment variables for each function', () => {
      // Diff Processor should have SLACK_WEBHOOK_SECRET_ARN
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-zengin-diff-processor',
        Environment: {
          Variables: {
            DIFF_TABLE_NAME: { Ref: expect.stringMatching(/^TestZenginDataUpdaterStackDiffTable/) },
            DATABASE_SECRET_ARN: global.testConfig.database.secretArn,
            SLACK_WEBHOOK_SECRET_ARN: global.testConfig.microservices.zenginDataUpdater.slack.webhookSecretArn,
            ENVIRONMENT: 'test',
          },
        },
      });

      // Callback Handler should have SCHEDULER_GROUP_NAME and SLACK_SIGN_SECRET_ARN
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-zengin-callback-handler',
        Environment: {
          Variables: {
            DIFF_TABLE_NAME: { Ref: expect.stringMatching(/^TestZenginDataUpdaterStackDiffTable/) },
            SCHEDULER_GROUP_NAME: 'zengin-data-updater-test',
            SLACK_SIGN_SECRET_ARN: global.testConfig.microservices.zenginDataUpdater.slack.signSecretArn,
            ENVIRONMENT: 'test',
          },
        },
      });
    });
  });

  describe('IAM Permissions', () => {
    it('should create IAM roles for Lambda functions', () => {
      const roles = template.findResources('AWS::IAM::Role');
      const lambdaRoles = Object.values(roles).filter((role: any) => 
        role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service === 'lambda.amazonaws.com'
      );

      expect(lambdaRoles).toHaveLength(3); // One for each Lambda function
    });

    it('should grant DynamoDB permissions to Lambda functions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: expect.arrayContaining([
            expect.objectContaining({
              Action: expect.arrayContaining([
                'dynamodb:BatchGetItem',
                'dynamodb:GetRecords',
                'dynamodb:GetShardIterator',
                'dynamodb:Query',
                'dynamodb:GetItem',
                'dynamodb:Scan',
                'dynamodb:ConditionCheckItem',
                'dynamodb:BatchWriteItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
              ]),
              Effect: 'Allow',
              Resource: expect.any(Object),
            }),
          ]),
        },
      });
    });

    it('should grant Secrets Manager permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: expect.arrayContaining([
            expect.objectContaining({
              Action: ['secretsmanager:GetSecretValue'],
              Effect: 'Allow',
              Resource: expect.any(String),
            }),
          ]),
        },
      });
    });

    it('should grant EventBridge Scheduler permissions to callback handler', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: expect.arrayContaining([
            expect.objectContaining({
              Action: expect.arrayContaining([
                'scheduler:CreateSchedule',
                'scheduler:UpdateSchedule',
                'scheduler:DeleteSchedule',
                'scheduler:GetSchedule',
                'scheduler:ListSchedules',
              ]),
              Effect: 'Allow',
              Resource: '*',
            }),
          ]),
        },
      });
    });
  });

  describe('EventBridge Scheduler', () => {
    it('should create EventBridge Scheduler Group', () => {
      template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', {
        Name: 'zengin-data-updater-test',
      });
    });

    it('should create daily schedule for diff processor', () => {
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        GroupName: 'zengin-data-updater-test',
        ScheduleExpression: 'cron(0 9 * * ? *)',
        Target: {
          Arn: expect.any(Object),
          RoleArn: expect.any(Object),
          Input: JSON.stringify({
            trigger: 'daily',
            source: 'eventbridge-scheduler',
          }),
        },
      });
    });

    it('should create IAM role for scheduler execution', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: {
                Service: 'scheduler.amazonaws.com',
              },
            },
          ],
        },
        ManagedPolicyArns: [
          {
            'Fn::Join': [
              '',
              [
                'arn:',
                { Ref: 'AWS::Partition' },
                ':iam::aws:policy/service-role/AmazonEventBridgeSchedulerLambdaRole',
              ],
            ],
          },
        ],
      });
    });
  });

  describe('CloudWatch Logs', () => {
    it('should create log groups for each Lambda function', () => {
      const expectedLogGroups = [
        '/aws/lambda/test-zengin-diff-processor',
        '/aws/lambda/test-zengin-callback-handler',
        '/aws/lambda/test-zengin-diff-executor',
      ];

      expectedLogGroups.forEach(logGroupName => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: logGroupName,
          RetentionInDays: 14,
        });
      });
    });
  });

  describe('Outputs', () => {
    it('should create CloudFormation outputs for important resources', () => {
      const outputs = template.findOutputs('*');

      // Check for DynamoDB table outputs
      expect(Object.keys(outputs)).toEqual(expect.arrayContaining([
        expect.stringMatching(/.*TableName/),
        expect.stringMatching(/.*TableArn/),
      ]));

      // Check for Lambda function outputs
      expect(Object.keys(outputs)).toEqual(expect.arrayContaining([
        expect.stringMatching(/.*FunctionArn/),
        expect.stringMatching(/.*FunctionName/),
      ]));
    });
  });

  describe('Tags', () => {
    it('should apply correct tags to resources', () => {
      const resources = template.findResources('AWS::Lambda::Function');
      
      Object.values(resources).forEach((resource: any) => {
        expect(resource.Properties.Tags).toEqual(expect.arrayContaining([
          { Key: 'Component', Value: 'Lambda' },
          { Key: 'Service', Value: 'ZenginDataUpdater' },
          { Key: 'Environment', Value: 'test' },
          { Key: 'Project', Value: 'AdvasaBusinessBase' },
        ]));
      });
    });
  });

  describe('Stack when disabled', () => {
    it('should not create resources when zenginDataUpdater is disabled', () => {
      const disabledConfig = {
        ...global.testConfig,
        microservices: {
          zenginDataUpdater: {
            ...global.testConfig.microservices.zenginDataUpdater,
            enabled: false,
          },
        },
      };

      const disabledApp = new cdk.App({
        context: {
          env: 'test',
          config: disabledConfig,
        },
      });

      const disabledVpcConstruct = new VpcConstruct(disabledApp, 'TestVpc', {
        config: disabledConfig,
        env: {
          account: disabledConfig.account,
          region: disabledConfig.region,
        },
      });

      const disabledStack = new ZenginDataUpdaterStack(disabledApp, 'TestDisabledStack', {
        config: disabledConfig,
        vpcConstruct: disabledVpcConstruct,
        env: {
          account: disabledConfig.account,
          region: disabledConfig.region,
        },
      });

      const disabledTemplate = getTemplate(disabledStack);

      // Should not have any Lambda functions
      expect(() => {
        disabledTemplate.hasResourceProperties('AWS::Lambda::Function', {});
      }).toThrow();

      // Should not have DynamoDB table
      expect(() => {
        disabledTemplate.hasResourceProperties('AWS::DynamoDB::Table', {});
      }).toThrow();
    });
  });
});