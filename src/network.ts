import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";

import { baseTags, namePrefix, network } from "./config";

/**
 * Networking layer for the GZCTF EKS cluster.
 *
 * Creates a VPC with public and private subnets across the configured number of
 * availability zones. Subnets are tagged for Kubernetes load-balancer
 * auto-discovery:
 *   - public subnets  -> `kubernetes.io/role/elb`           (internet-facing LBs)
 *   - private subnets -> `kubernetes.io/role/internal-elb`  (internal LBs)
 *
 * EKS worker nodes run in the private subnets; the public subnets host the
 * internet-facing ALB/NLB and NAT gateway(s).
 */
export interface Network {
  vpc: awsx.ec2.Vpc;
  vpcId: pulumi.Output<string>;
  publicSubnetIds: pulumi.Output<string[]>;
  privateSubnetIds: pulumi.Output<string[]>;
}

export function createNetwork(): Network {
  const vpc = new awsx.ec2.Vpc(`${namePrefix}-vpc`, {
    cidrBlock: network.cidrBlock,
    numberOfAvailabilityZones: network.azCount,
    // A single shared NAT gateway is cheaper; flip `singleNatGateway` to false
    // for one-per-AZ high availability in production.
    natGateways: {
      strategy: network.singleNatGateway ? "Single" : "OnePerAz",
    },
    subnetSpecs: [
      {
        type: "Public",
        tags: { "kubernetes.io/role/elb": "1", ...baseTags },
      },
      {
        type: "Private",
        tags: { "kubernetes.io/role/internal-elb": "1", ...baseTags },
      },
    ],
    tags: { Name: `${namePrefix}-vpc`, ...baseTags },
  });

  return {
    vpc,
    vpcId: vpc.vpcId,
    publicSubnetIds: vpc.publicSubnetIds,
    privateSubnetIds: vpc.privateSubnetIds,
  };
}
