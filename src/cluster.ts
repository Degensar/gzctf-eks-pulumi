import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { baseTags, cluster as clusterCfg, namePrefix } from "./config";
import { createIrsaRole } from "./irsa";
import { Network } from "./network";

/**
 * The EKS cluster and the handles other modules need to build on top of it.
 */
export interface ClusterResources {
  cluster: eks.Cluster;
  /** k8s provider wired to the new cluster, for creating in-cluster resources. */
  provider: k8s.Provider;
  kubeconfig: pulumi.Output<unknown>;
  clusterName: pulumi.Output<string>;
  oidcProviderArn: pulumi.Output<string>;
  oidcProviderUrl: pulumi.Output<string>;
  /** EKS-managed security group attached to the control plane and nodes. */
  clusterSecurityGroupId: pulumi.Output<string>;
  /** Security group attached to worker nodes. */
  nodeSecurityGroupId: pulumi.Output<string>;
}

export function createCluster(net: Network): ClusterResources {
  // --- Worker node IAM role ------------------------------------------------
  // The managed node group uses this role; it is also registered with the
  // cluster (via `instanceRoles`) so nodes are authorised to join.
  const nodeRole = new aws.iam.Role(`${namePrefix}-node`, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: "ec2.amazonaws.com",
    }),
    tags: { ...baseTags, Name: `${namePrefix}-node` },
  });

  const nodePolicyArns = [
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    // Allows node access via SSM Session Manager (no SSH keys / bastion).
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  ];
  nodePolicyArns.forEach((policyArn, i) => {
    new aws.iam.RolePolicyAttachment(`${namePrefix}-node-attach-${i}`, {
      role: nodeRole.name,
      policyArn,
    });
  });

  // --- EKS control plane ---------------------------------------------------
  const cluster = new eks.Cluster(namePrefix, {
    name: namePrefix,
    vpcId: net.vpcId,
    publicSubnetIds: net.publicSubnetIds,
    privateSubnetIds: net.privateSubnetIds,
    version: clusterCfg.k8sVersion,
    // We attach our own managed node group below.
    skipDefaultNodeGroup: true,
    // Register the worker role so nodes can authenticate.
    instanceRoles: [nodeRole],
    // Enable the IAM OIDC provider so workloads can use IRSA.
    createOidcProvider: true,
    // Modern access-entry auth, while keeping the aws-auth ConfigMap for the
    // node role mapping above.
    authenticationMode: "API_AND_CONFIG_MAP",
    endpointPrivateAccess: true,
    endpointPublicAccess: true,
    // Nodes live in private subnets and reach the internet via NAT only.
    nodeAssociatePublicIpAddress: false,
    enabledClusterLogTypes: ["api", "audit", "authenticator"],
    tags: { ...baseTags, Name: namePrefix },
  });

  // --- Managed node group --------------------------------------------------
  const nodeGroup = new eks.ManagedNodeGroup(`${namePrefix}-ng`, {
    cluster,
    nodeRole,
    subnetIds: net.privateSubnetIds,
    instanceTypes: [clusterCfg.nodeInstanceType],
    amiType: "AL2023_x86_64_STANDARD",
    capacityType: "ON_DEMAND",
    diskSize: clusterCfg.nodeDiskSize,
    scalingConfig: {
      desiredSize: clusterCfg.nodeDesiredSize,
      minSize: clusterCfg.nodeMinSize,
      maxSize: clusterCfg.nodeMaxSize,
    },
    labels: { "gzctf.io/role": "workers" },
    tags: { ...baseTags },
  });

  // --- EKS managed add-ons -------------------------------------------------
  // vpc-cni and kube-proxy are managed by the eks.Cluster component. We add
  // CoreDNS and the EBS CSI driver (the latter needs an IRSA role).
  const clusterName = cluster.eksCluster.name;

  new aws.eks.Addon(
    `${namePrefix}-coredns`,
    {
      clusterName,
      addonName: "coredns",
      resolveConflictsOnCreate: "OVERWRITE",
      resolveConflictsOnUpdate: "OVERWRITE",
      tags: baseTags,
    },
    { dependsOn: [nodeGroup] },
  );

  const ebsCsiRole = createIrsaRole(`${namePrefix}-ebs-csi`, {
    oidcProviderArn: cluster.oidcProviderArn,
    oidcProviderUrl: cluster.oidcProviderUrl,
    namespace: "kube-system",
    serviceAccountName: "ebs-csi-controller-sa",
    policyArns: [
      "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
    ],
  });

  new aws.eks.Addon(
    `${namePrefix}-ebs-csi`,
    {
      clusterName,
      addonName: "aws-ebs-csi-driver",
      serviceAccountRoleArn: ebsCsiRole.arn,
      resolveConflictsOnCreate: "OVERWRITE",
      resolveConflictsOnUpdate: "OVERWRITE",
      tags: baseTags,
    },
    { dependsOn: [nodeGroup] },
  );

  // --- Kubernetes provider -------------------------------------------------
  const provider = new k8s.Provider(
    `${namePrefix}-k8s`,
    { kubeconfig: cluster.kubeconfigJson, enableServerSideApply: true },
    { dependsOn: [nodeGroup] },
  );

  return {
    cluster,
    provider,
    kubeconfig: cluster.kubeconfig,
    clusterName,
    oidcProviderArn: cluster.oidcProviderArn,
    oidcProviderUrl: cluster.oidcProviderUrl,
    clusterSecurityGroupId: cluster.clusterSecurityGroupId,
    nodeSecurityGroupId: cluster.nodeSecurityGroupId,
  };
}
