/**
 * GZCTF on AWS EKS — Pulumi entrypoint.
 *
 * Each layer of the infrastructure lives in its own module under `src/` and is
 * wired together here. Modules are added incrementally:
 *   - network  : VPC, public/private subnets, NAT  (implemented)
 *   - cluster  : EKS control plane, node group, addons, IRSA  (planned)
 *   - database : RDS PostgreSQL  (planned)
 *   - cache    : ElastiCache Redis  (planned)
 *   - storage  : EFS for /app/files  (planned)
 *   - gzctf    : Kubernetes workload (Deployment, Service, Ingress, RBAC) (planned)
 */
import { createNetwork } from "./src/network";

const net = createNetwork();

export const vpcId = net.vpcId;
export const publicSubnetIds = net.publicSubnetIds;
export const privateSubnetIds = net.privateSubnetIds;
