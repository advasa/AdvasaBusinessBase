import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Config } from '../config';

export interface VpcConstructProps extends cdk.StackProps {
  config: Config;
}

export class VpcConstruct extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  public readonly vpcEndpoints: { [key: string]: ec2.InterfaceVpcEndpoint };

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id, props);

    const { config } = props;

    // 既存VPCをインポート
    this.vpc = ec2.Vpc.fromLookup(this, 'ImportedVpc', {
      vpcId: config.vpc.vpcId,
    });

    // プライベートサブネットをインポート
    this.privateSubnets = config.vpc.privateSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `PrivateSubnet${index + 1}`, subnetId)
    );

    // パブリックサブネットをインポート
    this.publicSubnets = config.vpc.publicSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `PublicSubnet${index + 1}`, subnetId)
    );

    // Lambda関数用のセキュリティグループを作成
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: true,
    });

    // データベース用のセキュリティグループを作成
    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for database access',
      allowAllOutbound: false,
    });

    // Lambda→データベース間の通信を許可
    this.databaseSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(config.database.port),
      'Allow Lambda functions to access database'
    );

    // VPCエンドポイントを作成（既存VPCでは作成しない）
    this.vpcEndpoints = {}; // 空のオブジェクトを設定
    this.vpcEndpoints = this.createVpcEndpoints();

    // タグを追加
    this.addTags();

    // CloudFormation出力
    this.createOutputs();
  }

  /**
   * VPCエンドポイントを作成
   * 
   * 既存VPCエンドポイント（手動作成済み、DNS有効）:
   * - com.amazonaws.ap-northeast-1.dynamodb (Gateway)
   * - com.amazonaws.ap-northeast-1.s3 (Gateway)  
   * - com.amazonaws.ap-northeast-1.ecr.api
   * - com.amazonaws.ap-northeast-1.ecr.dkr
   * - com.amazonaws.ap-northeast-1.secretsmanager（手動作成、DNS有効）
   * 
   * CDKで管理（DNS競合回避）:
   * - com.amazonaws.ap-northeast-1.secretsmanager（冗長化、DNS無効）
   * - com.amazonaws.ap-northeast-1.lambda（新規追加、DNS有効）
   * - com.amazonaws.ap-northeast-1.logs（CDK管理、DNS有効）
   * - com.amazonaws.ap-northeast-1.monitoring（CDK管理、DNS有効）
   * - com.amazonaws.ap-northeast-1.events（新規追加、DNS有効）
   * - com.amazonaws.ap-northeast-1.scheduler（新規追加、DNS有効）
   * 
   * 戦略: 既存の手動エンドポイントを活用し、CDKエンドポイントは冗長化として追加
   */
  private createVpcEndpoints(): { [key: string]: ec2.InterfaceVpcEndpoint } {
    const endpoints: { [key: string]: ec2.InterfaceVpcEndpoint } = {};

    // Lambda用VPCエンドポイント（新規作成、DNS解決有効）
    endpoints.lambda = new ec2.InterfaceVpcEndpoint(this, 'LambdaVpcEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
      subnets: {
        subnets: this.privateSubnets,
      },
      securityGroups: [this.createVpcEndpointSecurityGroup('Lambda')],
      privateDnsEnabled: true, // Lambda API呼び出しにはDNS解決が必要
    });

    // CloudWatch Logs用VPCエンドポイント（CDKで管理、DNS解決有効）
    endpoints.cloudWatchLogs = new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsVpcEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: {
        subnets: this.privateSubnets,
      },
      securityGroups: [this.createVpcEndpointSecurityGroup('CloudWatchLogs')],
      privateDnsEnabled: true, // ログ出力にはDNS解決が必要
    });

    // CloudWatch (monitoring)用VPCエンドポイント（CDKで管理、DNS解決有効）
    endpoints.cloudWatch = new ec2.InterfaceVpcEndpoint(this, 'CloudWatchVpcEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
      subnets: {
        subnets: this.privateSubnets,
      },
      securityGroups: [this.createVpcEndpointSecurityGroup('CloudWatch')],
      privateDnsEnabled: true, // メトリクス送信にはDNS解決が必要
    });

    // EventBridge用VPCエンドポイント（新規作成、DNS解決有効）
    endpoints.eventBridge = new ec2.InterfaceVpcEndpoint(this, 'EventBridgeVpcEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE,
      subnets: {
        subnets: this.privateSubnets,
      },
      securityGroups: [this.createVpcEndpointSecurityGroup('EventBridge')],
      privateDnsEnabled: true, // イベント送信にはDNS解決が必要
    });

    // EventBridge Scheduler用VPCエンドポイント（新規作成、DNS解決有効）
    endpoints.scheduler = new ec2.InterfaceVpcEndpoint(this, 'SchedulerVpcEndpoint', {
      vpc: this.vpc,
      service: new ec2.InterfaceVpcEndpointService('com.amazonaws.ap-northeast-1.scheduler'),
      subnets: {
        subnets: this.privateSubnets,
      },
      securityGroups: [this.createVpcEndpointSecurityGroup('Scheduler')],
      privateDnsEnabled: true, // スケジュール管理にはDNS解決が必要
    });

    return endpoints;
  }

  /**
   * VPCエンドポイント用のセキュリティグループを作成
   */
  private createVpcEndpointSecurityGroup(serviceName: string): ec2.SecurityGroup {
    const sg = new ec2.SecurityGroup(this, `${serviceName}VpcEndpointSecurityGroup`, {
      vpc: this.vpc,
      description: `Security group for ${serviceName} VPC endpoint`,
      allowAllOutbound: false,
    });

    // Lambda関数からのHTTPS通信を許可
    sg.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(443),
      `Allow Lambda functions to access ${serviceName} VPC endpoint`
    );

    return sg;
  }

  /**
   * NAT Gateway用のセキュリティグループを作成（必要に応じて）
   */
  public createNatGatewaySecurityGroup(): ec2.SecurityGroup {
    const sg = new ec2.SecurityGroup(this, 'NatGatewaySecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for NAT Gateway',
      allowAllOutbound: true,
    });

    // プライベートサブネットからのアウトバウンド通信を許可
    sg.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.allTcp(),
      'Allow traffic from private subnets'
    );

    return sg;
  }

  /**
   * Lambda関数に必要な追加のセキュリティグループルールを設定
   */
  public configureLambdaNetworking(): void {
    // HTTPS通信を許可（AWS API呼び出し用）- NAT Gateway経由
    this.lambdaSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS outbound traffic for AWS API calls via NAT Gateway'
    );

    // HTTP通信を許可（必要に応じて）
    this.lambdaSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP outbound traffic'
    );

    // DNS解決のためのUDP 53を許可
    this.lambdaSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(53),
      'Allow DNS resolution'
    );

    // TCP DNS解決も許可（冗長化のため）
    this.lambdaSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(53),
      'Allow TCP DNS resolution'
    );

    // Lambda関数はNAT Gateway経由でAWS APIにアクセスします
    // VPCエンドポイントはDNS解決を有効化してSlack API呼び出しを安定化
  }

  /**
   * タグを追加
   */
  private addTags(): void {
    const { config } = this.node.tryGetContext('config') || { config: { env: 'dev', projectName: 'AdvasaBusinessBase' } };

    // セキュリティグループにタグを追加
    cdk.Tags.of(this.lambdaSecurityGroup).add('Component', 'SecurityGroup');
    cdk.Tags.of(this.lambdaSecurityGroup).add('Service', 'Lambda');
    cdk.Tags.of(this.lambdaSecurityGroup).add('Name', `${config.env}-${config.projectName}-Lambda-SG`);

    cdk.Tags.of(this.databaseSecurityGroup).add('Component', 'SecurityGroup');
    cdk.Tags.of(this.databaseSecurityGroup).add('Service', 'Database');
    cdk.Tags.of(this.databaseSecurityGroup).add('Name', `${config.env}-${config.projectName}-Database-SG`);

    // VPCエンドポイントにタグを追加
    Object.entries(this.vpcEndpoints).forEach(([name, endpoint]) => {
      cdk.Tags.of(endpoint).add('Component', 'VPCEndpoint');
      cdk.Tags.of(endpoint).add('Service', name);
    });
  }

  /**
   * CloudFormation出力
   */
  private createOutputs(): void {
    const { config } = this.node.tryGetContext('config') || { config: { env: 'dev', projectName: 'AdvasaBusinessBase' } };

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: `${config.env}-${config.projectName}-VpcId`,
    });

    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: this.privateSubnets.map(subnet => subnet.subnetId).join(','),
      description: 'Private subnet IDs',
      exportName: `${config.env}-${config.projectName}-PrivateSubnetIds`,
    });

    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: this.publicSubnets.map(subnet => subnet.subnetId).join(','),
      description: 'Public subnet IDs',
      exportName: `${config.env}-${config.projectName}-PublicSubnetIds`,
    });

    new cdk.CfnOutput(this, 'LambdaSecurityGroupId', {
      value: this.lambdaSecurityGroup.securityGroupId,
      description: 'Lambda security group ID',
      exportName: `${config.env}-${config.projectName}-LambdaSecurityGroupId`,
    });

    new cdk.CfnOutput(this, 'DatabaseSecurityGroupId', {
      value: this.databaseSecurityGroup.securityGroupId,
      description: 'Database security group ID',
      exportName: `${config.env}-${config.projectName}-DatabaseSecurityGroupId`,
    });
  }

  /**
   * Lambda関数用のVPC設定を取得
   */
  public getLambdaVpcConfig(): {
    vpc: ec2.IVpc;
    securityGroups: ec2.ISecurityGroup[];
    vpcSubnets: ec2.SubnetSelection;
  } {
    return {
      vpc: this.vpc,
      securityGroups: [this.lambdaSecurityGroup],
      vpcSubnets: {
        subnets: this.privateSubnets,
      },
    };
  }

  /**
   * 指定されたポートでのアクセスを許可するセキュリティグループルールを追加
   */
  public allowPortAccess(
    sourceSecurityGroup: ec2.ISecurityGroup,
    targetSecurityGroup: ec2.SecurityGroup,
    port: number,
    protocol: 'tcp' | 'udp' = 'tcp',
    description?: string
  ): void {
    const portRule = protocol === 'tcp' ? ec2.Port.tcp(port) : ec2.Port.udp(port);
    targetSecurityGroup.addIngressRule(
      sourceSecurityGroup,
      portRule,
      description || `Allow access on port ${port}`
    );
  }

}