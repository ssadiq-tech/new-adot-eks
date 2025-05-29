import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as path from 'path';
import { RemovalPolicy } from 'aws-cdk-lib';
import { KubectlV29Layer } from '@aws-cdk/lambda-layer-kubectl-v29';

export class AdotEksDaemonsetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Configuration
    const config = {
      account: process.env.CDK_DEFAULT_ACCOUNT || '131332286832',
      region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
      clusterName: 'adot-eks-clusters',
      oidcProviderId: 'DCEC6B0056C380571D6F9FB7CC4D2456',
      namespace: 'adot-namespace',
      serviceAccount: 'adot-sa'
    };

    // 2. Kubectl layer
    const kubectlLayer = new KubectlV29Layer(this, 'KubectlLayer');

    // 3. Create new kubectl role instead of importing
    const kubectlRole = new iam.Role(this, 'KubectlExecutionRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.AccountPrincipal(config.account)
      ),
      roleName: `EksKubectlRole-${config.clusterName}`,
    });

    // 4. Grant required permissions to kubectl role
    kubectlRole.addToPolicy(new iam.PolicyStatement({
      actions: ['eks:DescribeCluster'],
      resources: [`arn:aws:eks:${config.region}:${config.account}:cluster/${config.clusterName}`]
    }));

    // 5. Import EKS cluster
    const cluster = eks.Cluster.fromClusterAttributes(this, 'EksCluster', {
      clusterName: config.clusterName,
      kubectlRoleArn: kubectlRole.roleArn,
      kubectlLayer: kubectlLayer,
      kubectlEnvironment: {
        PATH: '/var/task:/var/lang/bin:/usr/local/bin:/usr/bin/:/bin:/opt/bin',
        KUBECONFIG: '/tmp/kubeconfig',
        AWS_STS_REGIONAL_ENDPOINTS: 'regional'
      },
      openIdConnectProvider: iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this,
        'OidcProvider',
        `arn:aws:iam::${config.account}:oidc-provider/oidc.eks.${config.region}.amazonaws.com/id/${config.oidcProviderId}`
      )
    });
    

    // 6. Create namespace
    const namespace = cluster.addManifest('AdotNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: config.namespace
      }
    });

    // 7. Create ADOT IAM role
    const adotRole = new iam.Role(this, 'AdotIamRole', {
      assumedBy: new iam.FederatedPrincipal(
        `arn:aws:iam::${config.account}:oidc-provider/oidc.eks.${config.region}.amazonaws.com/id/${config.oidcProviderId}`,
        {
          'StringEquals': {
            [`oidc.eks.${config.region}.amazonaws.com/id/${config.oidcProviderId}:sub`]: 
              `system:serviceaccount:${config.namespace}:${config.serviceAccount}`,
          }
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy')
      ]
    });

    // 8. Create service account
    const adotSA = cluster.addServiceAccount('AdotServiceAccount', {
      name: config.serviceAccount,
      namespace: config.namespace,
    });
    adotSA.node.addDependency(namespace);

    // 9. Load collector config
    const collectorConfig = fs.readFileSync(path.join(__dirname, '../adot/collector.yaml'), 'utf8');

    // 10. Create ConfigMap
    const configMap = cluster.addManifest('AdotCollectorConfig', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'adot-collector-config',
        namespace: config.namespace,
      },
      data: {
        'collector.yaml': collectorConfig,
        skipValidation: true,
      },
    });
    configMap.node.addDependency(namespace);

    // 11. Create DaemonSet
    const daemonSet = cluster.addManifest('AdotDaemonSet', {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: {
        name: 'adot-collector',
        namespace: config.namespace,
        labels: { app: 'adot-collector' },
      },
      spec: {
        selector: {
          matchLabels: { app: 'adot-collector' },
        },
        template: {
          metadata: {
            labels: { app: 'adot-collector' },
          },
          spec: {
            serviceAccountName: config.serviceAccount,
            containers: [
              {
                name: 'adot-collector',
                image: 'public.ecr.aws/aws-observability/aws-otel-collector:latest',
                args: ['--config=/etc/otel/collector.yaml'],
                volumeMounts: [
                  {
                    name: 'config-volume',
                    mountPath: '/etc/otel',
                  },
                ],
                resources: {
                  limits: {
                    cpu: '1',
                    memory: '1Gi'
                  },
                  requests: {
                    cpu: '200m',
                    memory: '512Mi'
                  }
                }
              },
            ],
            volumes: [
              {
                name: 'config-volume',
                configMap: {
                  name: 'adot-collector-config',
                  items: [
                    {
                      key: 'collector.yaml',
                      path: 'collector.yaml',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    daemonSet.node.addDependency(adotSA, configMap);

    // 12. Apply removal policies
    [adotRole, adotSA, configMap, daemonSet].forEach(resource => {
      (resource.node.defaultChild as cdk.CfnResource)?.applyRemovalPolicy(RemovalPolicy.RETAIN);
    });
  }
}
