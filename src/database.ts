import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import { ClusterResources } from "./cluster";
import { baseTags, database as dbCfg, namePrefix } from "./config";
import { Network } from "./network";
import { createDataStoreSecurityGroup } from "./security";

/**
 * Managed PostgreSQL (RDS) for GZCTF's relational data.
 */
export interface Database {
  instance: aws.rds.Instance;
  /** Npgsql connection string for GZCTF's `ConnectionStrings:Database`. */
  connectionString: pulumi.Output<string>;
  /** Plain host:port endpoint (non-secret), useful for diagnostics. */
  endpoint: pulumi.Output<string>;
}

export function createDatabase(net: Network, eks: ClusterResources): Database {
  const sg = createDataStoreSecurityGroup(`${namePrefix}-db-sg`, {
    vpcId: net.vpcId,
    port: 5432,
    sourceSecurityGroupIds: [
      eks.clusterSecurityGroupId,
      eks.nodeSecurityGroupId,
    ],
  });

  const subnetGroup = new aws.rds.SubnetGroup(`${namePrefix}-db-subnets`, {
    subnetIds: net.privateSubnetIds,
    tags: { ...baseTags, Name: `${namePrefix}-db-subnets` },
  });

  // Use the configured secret password, or generate a strong one. The override
  // set deliberately excludes characters that break Npgsql connection strings
  // or RDS master passwords (`;`, `@`, `/`, `"`, space).
  const generated = new random.RandomPassword(`${namePrefix}-db-password`, {
    length: 24,
    special: true,
    overrideSpecial: "!#$%^&*()-_=+[]{}",
  });
  const password = pulumi.secret(dbCfg.password ?? generated.result);

  const instance = new aws.rds.Instance(`${namePrefix}-db`, {
    engine: "postgres",
    engineVersion: dbCfg.engineVersion,
    instanceClass: dbCfg.instanceClass,
    allocatedStorage: dbCfg.allocatedStorage,
    maxAllocatedStorage: dbCfg.maxAllocatedStorage,
    storageType: "gp3",
    storageEncrypted: true,
    dbName: dbCfg.databaseName,
    username: dbCfg.username,
    password,
    dbSubnetGroupName: subnetGroup.name,
    vpcSecurityGroupIds: [sg.id],
    multiAz: dbCfg.multiAz,
    publiclyAccessible: false,
    backupRetentionPeriod: dbCfg.backupRetentionDays,
    deletionProtection: dbCfg.deletionProtection,
    // Skip the final snapshot for easy teardown in non-prod; set
    // dbDeletionProtection/dbFinalSnapshot for production stacks.
    skipFinalSnapshot: true,
    applyImmediately: true,
    tags: { ...baseTags, Name: `${namePrefix}-db` },
  });

  const connectionString = pulumi
    .all([instance.address, instance.port, password])
    .apply(
      ([host, port, pw]) =>
        `Host=${host};Port=${port};Database=${dbCfg.databaseName};` +
        `Username=${dbCfg.username};Password=${pw}`,
    );

  return {
    instance,
    connectionString: pulumi.secret(connectionString),
    endpoint: pulumi.interpolate`${instance.address}:${instance.port}`,
  };
}
