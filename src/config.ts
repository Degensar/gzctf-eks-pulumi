import * as pulumi from "@pulumi/pulumi";

/**
 * Centralised, typed view of the stack configuration.
 *
 * Values are read from the Pulumi stack config (e.g. `Pulumi.dev.yaml`) under
 * the `gzctf-eks:` namespace. Every value has a sensible default so the project
 * can be previewed without a fully-populated config file.
 */
const cfg = new pulumi.Config();
const stack = pulumi.getStack();

/** Resource name prefix, e.g. "gzctf-dev". Keeps names unique per stack. */
export const namePrefix = `${cfg.get("namePrefix") ?? "gzctf"}-${stack}`;

/** Tags applied to every taggable AWS resource. */
export const baseTags: Record<string, string> = {
  Project: "gzctf",
  Stack: stack,
  ManagedBy: "pulumi",
};

export const network = {
  /** CIDR block for the VPC. */
  cidrBlock: cfg.get("vpcCidr") ?? "10.0.0.0/16",
  /** Number of availability zones to spread subnets across. */
  azCount: cfg.getNumber("azCount") ?? 2,
  /**
   * Use a single NAT gateway shared across AZs (cheaper, lower availability)
   * instead of one per AZ. Defaults to true to keep dev costs down.
   */
  singleNatGateway: cfg.getBoolean("singleNatGateway") ?? true,
};

export const database = {
  /** PostgreSQL engine major version. */
  engineVersion: cfg.get("dbEngineVersion") ?? "16",
  /** RDS instance class. */
  instanceClass: cfg.get("dbInstanceClass") ?? "db.t4g.micro",
  /** Initial allocated storage, in GiB. */
  allocatedStorage: cfg.getNumber("dbAllocatedStorage") ?? 20,
  /** Storage autoscaling ceiling, in GiB. */
  maxAllocatedStorage: cfg.getNumber("dbMaxAllocatedStorage") ?? 100,
  /** Master username / GZCTF DB user. */
  username: cfg.get("dbUsername") ?? "gzctf",
  /** Database name. */
  databaseName: cfg.get("dbName") ?? "gzctf",
  /** Optional explicit password (secret). Generated if unset. */
  password: cfg.getSecret("dbPassword"),
  /** Deploy across multiple AZs for HA. */
  multiAz: cfg.getBoolean("dbMultiAz") ?? false,
  /** Automated backup retention, in days. */
  backupRetentionDays: cfg.getNumber("dbBackupRetentionDays") ?? 7,
  /** Block accidental deletion of the instance. */
  deletionProtection: cfg.getBoolean("dbDeletionProtection") ?? false,
};

export const cache = {
  /** Redis engine version. */
  engineVersion: cfg.get("redisEngineVersion") ?? "7.1",
  /** ElastiCache node type. */
  nodeType: cfg.get("redisNodeType") ?? "cache.t4g.micro",
  /** Number of cache nodes (1 = single node; >1 adds replicas + failover). */
  numCacheClusters: cfg.getNumber("redisNumCacheClusters") ?? 1,
};

export const cluster = {
  /** Kubernetes control-plane version. */
  k8sVersion: cfg.get("k8sVersion") ?? "1.32",
  /** EC2 instance type for worker nodes. */
  nodeInstanceType: cfg.get("nodeInstanceType") ?? "t3.large",
  /** Desired number of worker nodes. */
  nodeDesiredSize: cfg.getNumber("nodeDesiredSize") ?? 2,
  /** Minimum number of worker nodes. */
  nodeMinSize: cfg.getNumber("nodeMinSize") ?? 2,
  /** Maximum number of worker nodes (autoscaling ceiling). */
  nodeMaxSize: cfg.getNumber("nodeMaxSize") ?? 4,
  /** Root EBS volume size per node, in GiB. */
  nodeDiskSize: cfg.getNumber("nodeDiskSize") ?? 50,
};
