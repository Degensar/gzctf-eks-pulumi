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
│   └── network.ts      # VPC, subnets, NAT
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

# Fetch a kubeconfig once the cluster module lands (PR #2)
pulumi stack output kubeconfig --show-secrets > kubeconfig
export KUBECONFIG=$PWD/kubeconfig
kubectl get nodes
```

### Configuration

| Key (`gzctf-eks:`) | Default        | Description                                  |
| ------------------ | -------------- | -------------------------------------------- |
| `namePrefix`       | `gzctf`        | Prefix for resource names                    |
| `vpcCidr`          | `10.0.0.0/16`  | VPC CIDR block                               |
| `azCount`          | `2`            | Availability zones to span                   |
| `singleNatGateway` | `true`         | Share one NAT gateway (cheaper) vs one-per-AZ |

`aws:region` is set via the standard AWS provider config.

## Roadmap

- [x] **PR #1** — Project scaffold, CI, VPC networking
- [ ] **PR #2** — EKS cluster, managed node group, IRSA, EKS add-ons (CNI,
      CoreDNS, kube-proxy, EBS/EFS CSI)
- [ ] **PR #3** — Data layer: RDS PostgreSQL + ElastiCache Redis
- [ ] **PR #4** — EFS storage class + AWS Load Balancer Controller
- [ ] **PR #5** — GZCTF Kubernetes workload (Deployment, Service, Ingress, RBAC)

## License

[MIT](./LICENSE)
