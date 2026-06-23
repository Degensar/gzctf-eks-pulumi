# GZCTF on AWS EKS (Pulumi)

Infrastructure-as-Code that provisions an [Amazon EKS](https://aws.amazon.com/eks/)
cluster and the supporting AWS resources needed to self-host
[**GZCTF**](https://github.com/GZTimeWalker/GZCTF), an open-source
Capture-The-Flag platform.

The stack is written in **TypeScript** with [Pulumi](https://www.pulumi.com/).

> [!NOTE]
> This repository is built up through a series of pull requests, one per
> infrastructure layer. See the [roadmap](#roadmap) for what is implemented.

## Architecture

```
                          Internet
                             │
                   ┌─────────▼──────────┐
                   │  ALB (Ingress)     │  public subnets
                   └─────────┬──────────┘
                             │
        ┌────────────────────▼─────────────────────┐
        │                EKS cluster                │  private subnets
        │                                           │
        │  ┌─────────────┐      ┌────────────────┐  │
        │  │  gzctf       │     │ gzctf-challenges│  │
        │  │ (Deployment) │────▶│  (per-team pods)│  │
        │  │  ServiceAcct │ RBAC│   NetworkPolicy │  │
        │  └──────┬───────┘     └────────────────┘  │
        └─────────┼─────────────────────────────────┘
                  │
        ┌─────────┼───────────────┬───────────────┐
        ▼         ▼               ▼               ▼
   RDS Postgres  ElastiCache    EFS            (EBS via CSI)
   (gzctf DB)    Redis (cache)  /app/files      node volumes
```

GZCTF runs inside the cluster and uses its **in-cluster ServiceAccount** to
launch challenge containers in a dedicated `gzctf-challenges` namespace (no
external kubeconfig is mounted). Persistent uploads/keys live on EFS so the
deployment can scale horizontally; relational data lives in RDS PostgreSQL and
the distributed cache in ElastiCache Redis.

## Repository layout

```
.
├── index.ts            # Pulumi entrypoint — wires the modules together
├── src/
│   ├── config.ts       # typed stack configuration
│   ├── network.ts      # VPC, subnets, NAT
│   ├── irsa.ts         # IAM Roles for Service Accounts helper
│   ├── cluster.ts      # EKS control plane, node group, IRSA, add-ons
│   ├── security.ts     # data-store security-group helper
│   ├── database.ts     # RDS PostgreSQL
│   ├── cache.ts        # ElastiCache Redis
│   ├── storage.ts      # EFS filesystem + CSI driver + StorageClass
│   ├── loadBalancer.ts # AWS Load Balancer Controller (Helm + IRSA)
│   ├── gzctf.ts        # GZCTF workload: ns, RBAC, secret, PVC, Deploy, Svc, Ingress
│   └── iam/            # vendored IAM policy for the LB controller
├── Pulumi.yaml         # project definition
├── Pulumi.dev.yaml     # example (non-secret) dev-stack config
└── .github/workflows/  # CI: type-check + (opt-in) pulumi preview
```

## Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/) v3
- Node.js 20+
- An AWS account and credentials (`aws configure` or environment variables)
- [`kubectl`](https://kubernetes.io/docs/tasks/tools/) to interact with the
  cluster after it is created

## Usage

```bash
npm install

# Select / create a stack
pulumi stack init dev

# Configure (region + any overrides). See Pulumi.dev.yaml for the full list.
pulumi config set aws:region us-east-1

# Preview / deploy
pulumi preview
pulumi up

# Fetch a kubeconfig and talk to the cluster
pulumi stack output kubeconfig --show-secrets > kubeconfig
export KUBECONFIG=$PWD/kubeconfig
kubectl get nodes

# After the stack is up: find the public URL and the initial admin password
pulumi stack output gzctfIngressHostname
pulumi stack output gzctfAdminPassword --show-secrets
```

Then point your domain (or set `publicEntry` to the ALB DNS name) and log in
as `Admin` with that password. For challenge proxying to work, set
`publicEntry` to the host players reach the platform on:

```bash
pulumi config set gzctf-eks:publicEntry ctf.example.com
pulumi config set gzctf-eks:domainName  ctf.example.com
pulumi config set gzctf-eks:acmCertificateArn arn:aws:acm:...   # optional HTTPS
pulumi up
```

> [!IMPORTANT]
> This repository has been validated by type-checking (`tsc`) but **not** by a
> live `pulumi up`, which requires AWS credentials. Review `pulumi preview`
> output and the cost implications (EKS, NAT, RDS, EFS, ALB) before applying.

### Configuration

| Key (`gzctf-eks:`) | Default        | Description                                  |
| ------------------ | -------------- | -------------------------------------------- |
| `namePrefix`       | `gzctf`        | Prefix for resource names                    |
| `vpcCidr`          | `10.0.0.0/16`  | VPC CIDR block                               |
| `azCount`          | `2`            | Availability zones to span                   |
| `singleNatGateway` | `true`         | Share one NAT gateway (cheaper) vs one-per-AZ |
| `k8sVersion`       | `1.32`         | EKS control-plane version                    |
| `nodeInstanceType` | `t3.large`     | Worker node EC2 instance type                |
| `nodeDesiredSize`  | `2`            | Desired worker node count                    |
| `nodeMinSize`      | `2`            | Minimum worker node count                    |
| `nodeMaxSize`      | `4`            | Maximum worker node count                    |
| `nodeDiskSize`     | `50`           | Worker node root volume size (GiB)           |
| `dbInstanceClass`  | `db.t4g.micro` | RDS instance class                           |
| `dbEngineVersion`  | `16`           | PostgreSQL major version                     |
| `dbAllocatedStorage` | `20`         | RDS storage (GiB), autoscales to 100         |
| `dbUsername` / `dbName` | `gzctf`   | RDS master user / database name              |
| `dbPassword`       | _generated_    | **Secret.** Set with `--secret`; auto-generated if unset |
| `redisNodeType`    | `cache.t4g.micro` | ElastiCache node type                     |
| `redisNumCacheClusters` | `1`       | Redis nodes (>1 → replicas + failover)       |
| `albChartVersion`  | `3.4.0`        | AWS Load Balancer Controller Helm chart      |
| `gzctfImage`       | `gztime/gzctf:v1.8.6` | GZCTF container image                 |
| `gzctfReplicas`    | `1`            | GZCTF Deployment replicas                    |
| `gzctfAdminPassword` | _generated_  | **Secret.** Initial admin password           |
| `publicEntry`      | _(empty)_      | Public host players use (PlatformProxy entry) |
| `domainName`       | _(empty)_      | Ingress host (empty = match any on the ALB)  |
| `acmCertificateArn`| _(empty)_      | ACM cert ARN → enables HTTPS on the ALB      |

`aws:region` is set via the standard AWS provider config. Set the DB password
(optional — one is generated otherwise) with:

```bash
pulumi config set --secret gzctf-eks:dbPassword 'a-strong-password'
```

## Roadmap

- [x] **PR #1** — Project scaffold, CI, VPC networking
- [x] **PR #2** — EKS cluster, managed node group, IRSA, EKS add-ons (CNI,
      CoreDNS, kube-proxy, EBS CSI)
- [x] **PR #3** — Data layer: RDS PostgreSQL + ElastiCache Redis
- [x] **PR #4** — EFS storage class + AWS Load Balancer Controller
- [x] **PR #5** — GZCTF Kubernetes workload (Deployment, Service, Ingress, RBAC)

## License

[MIT](./LICENSE)
