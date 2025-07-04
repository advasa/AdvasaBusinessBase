#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ConfigLoader } from '../lib/common/config';
import { VpcConstruct } from '../lib/common/networking/vpc-construct';
import { ZenginDataUpdaterStack } from '../lib/microservices/zengin-data-updater/zengin-data-updater-stack';

const app = new cdk.App();

// 環境を取得（デフォルトは 'dev'）
const env = app.node.tryGetContext('env') || 'dev';

// 設定を読み込み
const config = ConfigLoader.getConfig(env);

// デプロイ環境を設定
const deployEnv = {
  account: config.account,
  region: config.region,
};

// 共通タグを設定
const commonTags = {
  Project: config.projectName,
  Environment: config.env,
  ManagedBy: 'CDK',
  ...config.tags,
};

// VPC構成を作成
const vpcConstruct = new VpcConstruct(app, `${config.env}-${config.projectName}-VPC`, {
  config,
  env: deployEnv,
});

// 全てのスタックを管理する配列
const stacks: cdk.Stack[] = [vpcConstruct];

// Zengin Data Updater マイクロサービス
if (config.microservices.zenginDataUpdater?.enabled) {
  const zenginDataUpdaterStack = new ZenginDataUpdaterStack(
    app,
    `${config.env}-${config.projectName}-ZenginDataUpdater`,
    {
      config,
      vpcConstruct,
      env: deployEnv,
    }
  );

  stacks.push(zenginDataUpdaterStack);
  
  // 依存関係を設定
  zenginDataUpdaterStack.addDependency(vpcConstruct);
}

// 本番環境では終了保護を有効化
const isProduction = config.env === 'prod';

// 全スタックに共通設定を適用
stacks.forEach((stack) => {
  // 共通タグを適用
  Object.entries(commonTags).forEach(([key, value]) => {
    cdk.Tags.of(stack).add(key, value);
  });

  // 本番環境では終了保護を有効化
  if (isProduction) {
    stack.terminationProtection = true;
  }

  // スタック説明を設定
  stack.templateOptions.description = `${config.projectName} ${config.env} environment - ${stack.node.id}`;
});

// アプリケーション合成
app.synth();