import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface XRayTracingProps {
  environment: string;
  lambdaFunctions?: lambda.Function[];
  apiGateways?: apigateway.RestApi[];
  enableActiveTracing?: boolean;
  samplingRate?: number;
}

export class XRayTracing extends Construct {
  constructor(scope: Construct, id: string, props: XRayTracingProps) {
    super(scope, id);

    const enableActiveTracing = props.enableActiveTracing ?? true;
    const samplingRate = props.samplingRate ?? 0.1; // 10% default sampling

    // Enable X-Ray tracing for Lambda functions
    if (props.lambdaFunctions) {
      props.lambdaFunctions.forEach(func => {
        this.enableLambdaTracing(func, enableActiveTracing);
      });
    }

    // Enable X-Ray tracing for API Gateways
    if (props.apiGateways) {
      props.apiGateways.forEach(api => {
        this.enableApiGatewayTracing(api, enableActiveTracing);
      });
    }

    // Create X-Ray sampling rule
    this.createSamplingRule(props.environment, samplingRate);
  }

  private enableLambdaTracing(func: lambda.Function, enableActiveTracing: boolean) {
    if (enableActiveTracing) {
      // Add X-Ray tracing configuration
      const cfnFunction = func.node.defaultChild as lambda.CfnFunction;
      cfnFunction.tracingConfig = {
        mode: 'Active',
      };

      // Add X-Ray permissions to Lambda execution role
      func.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
            'xray:GetSamplingRules',
            'xray:GetSamplingTargets',
          ],
          resources: ['*'],
        })
      );

      // Add X-Ray SDK environment variables
      func.addEnvironment('_X_AMZN_TRACE_ID', '');
      func.addEnvironment('AWS_XRAY_TRACING_NAME', func.functionName);
      func.addEnvironment('AWS_XRAY_CONTEXT_MISSING', 'LOG_ERROR');
    }
  }

  private enableApiGatewayTracing(api: apigateway.RestApi, enableActiveTracing: boolean) {
    if (enableActiveTracing) {
      // Enable X-Ray tracing for API Gateway
      const cfnStage = api.deploymentStage.node.defaultChild as apigateway.CfnStage;
      cfnStage.tracingEnabled = true;
    }
  }

  private createSamplingRule(environment: string, samplingRate: number) {
    // Create X-Ray sampling rule for the environment
    new cdk.CfnResource(this, 'XRaySamplingRule', {
      type: 'AWS::XRay::SamplingRule',
      properties: {
        SamplingRule: {
          RuleName: `${environment}-default-sampling`,
          Priority: 9000,
          FixedRate: samplingRate,
          ReservoirSize: 1,
          ServiceName: '*',
          ServiceType: '*',
          Host: '*',
          HTTPMethod: '*',
          URLPath: '*',
          Version: 1,
        },
      },
    });
  }

  public static createXRayLayer(scope: Construct, id: string): lambda.LayerVersion {
    // Create X-Ray SDK layer for Python Lambda functions
    return new lambda.LayerVersion(scope, id, {
      code: lambda.Code.fromAsset('src/layers/xray'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
      description: 'AWS X-Ray SDK for Python',
    });
  }
}