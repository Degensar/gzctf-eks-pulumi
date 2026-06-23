/**
 * GZCTF on AWS EKS — Pulumi entrypoint.
 *
 * Each layer of the infrastructure lives in its own module under `src/` and is
 * wired together here. Modules are added incrementally:
 *   - network  : VPC, public/private subnets, NAT  (implemented)
 *   - cluster  : EKS control plane, node group, addons, IRSA  (implemented)
 *   - database : RDS PostgreSQL  (planned)
 *   - cache    : ElastiCache Redis  (planned)
 *   - storage  : EFS for /app/files  (planned)
 *   - gzctf    : Kubernetes workload (Deployment, Service, Ingress, RBAC) (planned)
 */
import * as pulumi from "@pulumi/pulumi";

import { createCluster } from "./src/cluster";
import { createNetwork } from "./src/network";

const net = createNetwork();
const eks = createCluster(net);

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
