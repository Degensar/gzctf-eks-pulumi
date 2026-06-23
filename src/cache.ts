import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { cache as cacheCfg, baseTags, namePrefix } from "./config";
import { ClusterResources } from "./cluster";
import { Network } from "./network";
import { createDataStoreSecurityGroup } from "./security";

/**
 * Managed Redis (ElastiCache) used by GZCTF as a distributed cache. A shared
 * cache is what lets the GZCTF Deployment scale beyond a single replica.
 */
export interface Cache {
  replicationGroup: aws.elasticache.ReplicationGroup;
  /** StackExchange.Redis connection string for `ConnectionStrings:RedisCache`. */
  connectionString: pulumi.Output<string>;
}

export function createCache(net: Network, eks: ClusterResources): Cache {
  const sg = createDataStoreSecurityGroup(`${namePrefix}-redis-sg`, {
    vpcId: net.vpcId,
    port: 6379,
    sourceSecurityGroupIds: [
      eks.clusterSecurityGroupId,
      eks.nodeSecurityGroupId,
    ],
  });

  const subnetGroup = new aws.elasticache.SubnetGroup(
    `${namePrefix}-redis-subnets`,
    {
      subnetIds: net.privateSubnetIds,
      tags: { ...baseTags, Name: `${namePrefix}-redis-subnets` },
    },
  );

  // Single-node by default. Increase `redisNumCacheClusters` for a primary +
  // read replicas with automatic failover.
  const multiNode = cacheCfg.numCacheClusters > 1;

  const replicationGroup = new aws.elasticache.ReplicationGroup(
    `${namePrefix}-redis`,
    {
      description: "GZCTF distributed cache",
      engine: "redis",
      engineVersion: cacheCfg.engineVersion,
      nodeType: cacheCfg.nodeType,
      numCacheClusters: cacheCfg.numCacheClusters,
      automaticFailoverEnabled: multiNode,
      multiAzEnabled: multiNode,
      port: 6379,
      subnetGroupName: subnetGroup.name,
      securityGroupIds: [sg.id],
      atRestEncryptionEnabled: true,
      // Transit encryption is left off so GZCTF can use a plain `host:port`
      // connection string; access is already restricted to the cluster by the
      // security group. Enable it (and add `ssl=true`) for stricter setups.
      transitEncryptionEnabled: false,
      applyImmediately: true,
      tags: { ...baseTags, Name: `${namePrefix}-redis` },
    },
  );

  const connectionString = pulumi.interpolate`${replicationGroup.primaryEndpointAddress}:${replicationGroup.port}`;

  return { replicationGroup, connectionString };
}
