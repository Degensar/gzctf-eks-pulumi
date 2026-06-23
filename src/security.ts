import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { baseTags } from "./config";

export interface DataStoreSecurityGroupArgs {
  vpcId: pulumi.Input<string>;
  /** TCP port to open for ingress (e.g. 5432 for Postgres, 6379 for Redis). */
  port: number;
  /** Source security groups allowed to connect (the EKS cluster + node SGs). */
  sourceSecurityGroupIds: pulumi.Input<string>[];
}

/**
 * Creates a security group for an in-VPC data store (RDS, ElastiCache) that
 * only accepts traffic on `port` from the given source security groups —
 * typically the EKS cluster and node security groups, so only pods/nodes can
 * reach it. Egress is unrestricted.
 */
export function createDataStoreSecurityGroup(
  name: string,
  args: DataStoreSecurityGroupArgs,
): aws.ec2.SecurityGroup {
  const sg = new aws.ec2.SecurityGroup(name, {
    vpcId: args.vpcId,
    description: `GZCTF data store — allow TCP ${args.port} from EKS`,
    egress: [
      {
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
        ipv6CidrBlocks: ["::/0"],
      },
    ],
    tags: { ...baseTags, Name: name },
  });

  args.sourceSecurityGroupIds.forEach((source, i) => {
    new aws.ec2.SecurityGroupRule(`${name}-ingress-${i}`, {
      type: "ingress",
      securityGroupId: sg.id,
      protocol: "tcp",
      fromPort: args.port,
      toPort: args.port,
      sourceSecurityGroupId: source,
    });
  });

  return sg;
}
