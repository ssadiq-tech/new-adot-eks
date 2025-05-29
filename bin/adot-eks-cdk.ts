#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AdotEksDaemonsetStack } from '../lib/adot-eks-cdk-stack';

const app = new cdk.App();
new AdotEksDaemonsetStack(app, 'AdotEksDaemonsetStack');
