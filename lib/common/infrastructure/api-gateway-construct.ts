import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Config } from '../config';

export interface ApiGatewayConstructProps {
  config: Config;
  apiName: string;
  description?: string;
  stage?: string;
  throttleRateLimit?: number;
  throttleBurstLimit?: number;
  enableCors?: boolean;
  endpointType?: apigateway.EndpointType;
}

export interface LambdaIntegrationConfig {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS';
  function: lambda.Function;
  requireAuth?: boolean;
  enableCors?: boolean;
  requestValidation?: boolean;
  requestParameters?: { [key: string]: boolean };
}

export class ApiGatewayConstruct extends Construct {
  public readonly api: apigateway.RestApi;
  public readonly logGroup: logs.LogGroup;
  public readonly stage: apigateway.Stage;
  public readonly url: string;

  constructor(scope: Construct, id: string, props: ApiGatewayConstructProps) {
    super(scope, id);

    const {
      config,
      apiName,
      description,
      stage = 'v1',
      throttleRateLimit = 1000,
      throttleBurstLimit = 2000,
      enableCors = true,
      endpointType = apigateway.EndpointType.REGIONAL,
    } = props;

    // CloudWatch Logs グループを作成
    this.logGroup = new logs.LogGroup(this, 'ApiGatewayLogGroup', {
      logGroupName: `/aws/apigateway/${apiName}`,
      retention: config.env === 'prod' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: config.env === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // API Gateway を作成
    this.api = new apigateway.RestApi(this, 'RestApi', {
      restApiName: apiName,
      description: description || `${apiName} API`,
      endpointConfiguration: {
        types: [endpointType],
      },
      deployOptions: {
        stageName: stage,
        throttlingRateLimit: throttleRateLimit,
        throttlingBurstLimit: throttleBurstLimit,
        // TEMPORARILY DISABLED: CloudWatch logging to avoid deployment issues
        // Will be re-enabled after account-level API Gateway logging role is properly configured
        // loggingLevel: config.env === 'prod' ? apigateway.MethodLoggingLevel.ERROR : apigateway.MethodLoggingLevel.INFO,
        // dataTraceEnabled: config.env !== 'prod',
        metricsEnabled: true,
        // accessLogDestination: new apigateway.LogGroupLogDestination(this.logGroup),
        // accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
        //   caller: true,
        //   httpMethod: true,
        //   ip: true,
        //   protocol: true,
        //   requestTime: true,
        //   resourcePath: true,
        //   responseLength: true,
        //   status: true,
        //   user: true,
        // }),
      },
      defaultCorsPreflightOptions: enableCors ? {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Slack-Request-Timestamp',
          'X-Slack-Signature',
        ],
      } : undefined,
    });

    // ステージの参照を保存
    this.stage = this.api.deploymentStage;
    this.url = this.api.url;

    // API Gateway実行ロールを作成
    const apiGatewayRole = new iam.Role(this, 'ApiGatewayRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
      ],
    });

    // Ensure the account-level CloudWatch Logs role is configured for API Gateway.
    // Without this, Stage creation fails with:
    //   "CloudWatch Logs role ARN must be set in account settings to enable logging"
    // This will be created only once per account/region. Subsequent stacks can safely
    // reference the same logical ID in their own scope without conflict.
    new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGatewayRole.roleArn,
    });

    // タグを追加
    this.addTags(config, apiName);

    // CloudFormation出力
    this.createOutputs(config, id);
  }

  /**
   * Lambda関数との統合を追加
   */
  public addLambdaIntegration(integrationConfig: LambdaIntegrationConfig): apigateway.Method {
    const {
      path,
      method,
      function: lambdaFunction,
      requireAuth = false,
      enableCors = true,
      requestValidation = false,
      requestParameters,
    } = integrationConfig;

    // リソースパスを解析して作成
    const resource = this.createResourcePath(path);

    // Lambda統合を作成
    const integration = new apigateway.LambdaIntegration(lambdaFunction, {
      proxy: true,
      allowTestInvoke: true,
    });

    // メソッドオプション
    const methodOptions: apigateway.MethodOptions = {
      authorizationType: requireAuth ? apigateway.AuthorizationType.IAM : apigateway.AuthorizationType.NONE,
    };

    // リクエストパラメータを設定
    if (requestParameters) {
      Object.assign(methodOptions, { requestParameters });
    }

    // リクエスト検証を設定
    if (requestValidation) {
      const validator = new apigateway.RequestValidator(this, `${path.replace(/\//g, '-')}-${method}-Validator`, {
        restApi: this.api,
        validateRequestBody: true,
        validateRequestParameters: !!requestParameters,
      });
      Object.assign(methodOptions, { requestValidator: validator });
    }

    // CORSオプション
    if (enableCors) {
      Object.assign(methodOptions, {
        methodResponses: [
          {
            statusCode: '200',
            responseHeaders: {
              'Access-Control-Allow-Origin': true,
              'Access-Control-Allow-Headers': true,
              'Access-Control-Allow-Methods': true,
            },
          },
          {
            statusCode: '400',
            responseHeaders: {
              'Access-Control-Allow-Origin': true,
            },
          },
          {
            statusCode: '500',
            responseHeaders: {
              'Access-Control-Allow-Origin': true,
            },
          },
        ],
      });
    }

    // メソッドを追加
    const apiMethod = resource.addMethod(method, integration, methodOptions);

    // Lambda関数にAPI Gateway実行権限を付与
    lambdaFunction.addPermission(`${path.replace(/\//g, '-')}-${method}-Permission`, {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: this.api.arnForExecuteApi(method, path),
    });

    return apiMethod;
  }

  /**
   * ヘルスチェックエンドポイントを追加
   */
  public addHealthCheck(): apigateway.Method {
    const healthResource = this.api.root.addResource('health');
    
    return healthResource.addMethod('GET', new apigateway.MockIntegration({
      integrationResponses: [
        {
          statusCode: '200',
          responseTemplates: {
            'application/json': JSON.stringify({
              status: 'OK',
              timestamp: '$context.requestTime',
              stage: '$context.stage',
            }),
          },
        },
      ],
      requestTemplates: {
        'application/json': '{"statusCode": 200}',
      },
    }), {
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });
  }

  /**
   * API使用量プランを追加
   */
  public addUsagePlan(
    planName: string,
    throttleRateLimit: number,
    throttleBurstLimit: number,
    quota?: number,
    quotaPeriod?: apigateway.Period
  ): apigateway.UsagePlan {
    const usagePlan = new apigateway.UsagePlan(this, `${planName}UsagePlan`, {
      name: planName,
      description: `Usage plan for ${planName}`,
      throttle: {
        rateLimit: throttleRateLimit,
        burstLimit: throttleBurstLimit,
      },
      quota: quota ? {
        limit: quota,
        period: quotaPeriod || apigateway.Period.DAY,
      } : undefined,
    });

    // API ステージを使用量プランに関連付け
    usagePlan.addApiStage({
      stage: this.stage,
    });

    return usagePlan;
  }

  /**
   * APIキーを作成
   */
  public createApiKey(keyName: string, description?: string): apigateway.ApiKey {
    return new apigateway.ApiKey(this, `${keyName}ApiKey`, {
      apiKeyName: keyName,
      description: description || `API key for ${keyName}`,
    });
  }

  /**
   * APIキーを使用量プランに関連付け
   */
  public associateApiKeyWithUsagePlan(apiKey: apigateway.ApiKey, usagePlan: apigateway.UsagePlan): void {
    usagePlan.addApiKey(apiKey);
  }

  /**
   * WAF WebACLを関連付け
   */
  public associateWebAcl(webAclArn: string): void {
    new cdk.CfnResource(this, 'WebAclAssociation', {
      type: 'AWS::WAFv2::WebACLAssociation',
      properties: {
        ResourceArn: this.stage.stageArn,
        WebACLArn: webAclArn,
      },
    });
  }

  /**
   * リソースパスを作成
   */
  private createResourcePath(path: string): apigateway.Resource {
    const pathParts = path.split('/').filter(part => part !== '');
    let currentResource: apigateway.IResource = this.api.root;

    for (const part of pathParts) {
      const existingResource = currentResource.getResource(part);
      if (existingResource) {
        currentResource = existingResource;
      } else {
        currentResource = currentResource.addResource(part);
      }
    }

    return currentResource as apigateway.Resource;
  }

  /**
   * タグを追加
   */
  private addTags(config: Config, apiName: string): void {
    cdk.Tags.of(this.api).add('Component', 'ApiGateway');
    cdk.Tags.of(this.api).add('Service', 'WebAPI');
    cdk.Tags.of(this.api).add('ApiName', apiName);

    cdk.Tags.of(this.logGroup).add('Component', 'CloudWatchLogs');
    cdk.Tags.of(this.logGroup).add('Service', 'ApiGateway');
    cdk.Tags.of(this.logGroup).add('ApiName', apiName);
  }

  /**
   * CloudFormation出力
   */
  private createOutputs(config: Config, id: string): void {
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: this.url,
      description: 'API Gateway URL',
      exportName: `${config.env}-${config.projectName}-${id}-ApiUrl`,
    });

    new cdk.CfnOutput(this, 'ApiGatewayId', {
      value: this.api.restApiId,
      description: 'API Gateway ID',
      exportName: `${config.env}-${config.projectName}-${id}-ApiId`,
    });

    new cdk.CfnOutput(this, 'ApiGatewayStage', {
      value: this.stage.stageName,
      description: 'API Gateway Stage',
      exportName: `${config.env}-${config.projectName}-${id}-ApiStage`,
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: this.logGroup.logGroupName,
      description: 'API Gateway Log Group Name',
      exportName: `${config.env}-${config.projectName}-${id}-LogGroupName`,
    });
  }

  /**
   * APIのメトリクス取得
   */
  public metricCount(): cdk.aws_cloudwatch.Metric {
    return new cdk.aws_cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      dimensionsMap: {
        ApiName: this.api.restApiName,
      },
    });
  }

  public metricLatency(): cdk.aws_cloudwatch.Metric {
    return new cdk.aws_cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Latency',
      dimensionsMap: {
        ApiName: this.api.restApiName,
      },
    });
  }

  public metricIntegrationLatency(): cdk.aws_cloudwatch.Metric {
    return new cdk.aws_cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'IntegrationLatency',
      dimensionsMap: {
        ApiName: this.api.restApiName,
      },
    });
  }

  public metric4XXError(): cdk.aws_cloudwatch.Metric {
    return new cdk.aws_cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '4XXError',
      dimensionsMap: {
        ApiName: this.api.restApiName,
      },
    });
  }

  public metric5XXError(): cdk.aws_cloudwatch.Metric {
    return new cdk.aws_cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5XXError',
      dimensionsMap: {
        ApiName: this.api.restApiName,
      },
    });
  }
}