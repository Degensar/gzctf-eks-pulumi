/**
 * GZCTF on AWS EKS — Pulumi entrypoint.
 *
 * Each layer of the infrastructure lives in its own module under `src/` and is
 * wired together here. Modules are added incrementally:
 *   - network  : VPC, public/private subnets, NAT  (implemented)
 *   - cluster  : EKS control plane, node group, addons, IRSA  (implemented)
 *   - database : RDS PostgreSQL  (implemented)
 *   - cache    : ElastiCache Redis  (implemented)
 *   - storage  : EFS for /app/files  (planned)
 *   - gzctf    : Kubernetes workload (Deployment, Service, Ingress, RBAC) (planned)
 */
import * as pulumi from "@pulumi/pulumi";

import { createCache } from "./src/cache";
import { createCluster } from "./src/cluster";
import { createDatabase } from "./src/database";
import { createNetwork } from "./src/network";

const net = createNetwork();
const eks = createCluster(net);
const db = createDatabase(net, eks);
const redis = createCache(net, eks);

// Networking
export const vpcId = net.vpcId;
export const publicSubnetIds = net.publicSubnetIds;
export const privateSubnetIds = net.privateSubnetIds;

// Cluster
export const clusterName = eks.clusterName;
export const clusterSecurityGroupId = eks.clusterSecurityGroupId;
export const oidcProviderArn = eks.oidcProviderArn;
// Marked secret: the kubeconfig embeds a token-exec credential helper.
export const kubeconfig = pulumi.secret(eks.kubeconfig);

// Data layer
export const dbEndpoint = db.endpoint;
export const dbConnectionString = db.connectionString; // secret
export const redisConnectionString = redis.connectionString;
