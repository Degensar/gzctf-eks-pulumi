import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

import { ClusterResources } from "./cluster";
import { baseTags, namePrefix, network as netCfg } from "./config";
import { createIrsaRole } from "./irsa";
import { Network } from "./network";
import { createDataStoreSecurityGroup } from "./security";

/**
 * Shared, persistent storage for GZCTF's `/app/files` directory (uploaded
 * assets and platform signing keys).
 *
 * EFS is used rather than EBS because it is ReadWriteMany: every GZCTF replica
 * mounts the same volume, which is what allows the Deployment to scale beyond
 * one pod. Dynamic provisioning is handled by the AWS EFS CSI driver using
 * access points (`provisioningMode: efs-ap`).
 */
export interface Storage {
  fileSystem: aws.efs.FileSystem;
  storageClass: k8s.storage.v1.StorageClass;
  /** StorageClass name for PVCs to reference. */
  storageClassName: string;
}

const STORAGE_CLASS_NAME = "efs-sc";

export function createStorage(net: Network, eks: ClusterResources): Storage {
  const sg = createDataStoreSecurityGroup(`${namePrefix}-efs-sg`, {
    vpcId: net.vpcId,
    port: 2049, // NFS
    sourceSecurityGroupIds: [
      eks.clusterSecurityGroupId,
      eks.nodeSecurityGroupId,
    ],
  });

  const fileSystem = new aws.efs.FileSystem(`${namePrefix}-efs`, {
    encrypted: true,
    performanceMode: "generalPurpose",
    throughputMode: "bursting",
    tags: { ...baseTags, Name: `${namePrefix}-efs` },
  });

  // One mount target per AZ/private subnet so pods on any node can reach EFS.
  const mountTargets = Array.from({ length: netCfg.azCount }, (_, i) =>
    new aws.efs.MountTarget(`${namePrefix}-efs-mt-${i}`, {
      fileSystemId: fileSystem.id,
      subnetId: net.privateSubnetIds.apply((ids) => ids[i]),
      securityGroups: [sg.id],
    }),
  );

  // EFS CSI driver (managed add-on) with an IRSA role for its controller SA.
  const efsCsiRole = createIrsaRole(`${namePrefix}-efs-csi`, {
    oidcProviderArn: eks.oidcProviderArn,
    oidcProviderUrl: eks.oidcProviderUrl,
    namespace: "kube-system",
    serviceAccountName: "efs-csi-controller-sa",
    policyArns: [
      "arn:aws:iam::aws:policy/service-role/AmazonEFSCSIDriverPolicy",
    ],
  });

  const efsAddon = new aws.eks.Addon(
    `${namePrefix}-efs-csi`,
    {
      clusterName: eks.clusterName,
      addonName: "aws-efs-csi-driver",
      serviceAccountRoleArn: efsCsiRole.arn,
      resolveConflictsOnCreate: "OVERWRITE",
      resolveConflictsOnUpdate: "OVERWRITE",
      tags: baseTags,
    },
    { dependsOn: mountTargets },
  );

  const storageClass = new k8s.storage.v1.StorageClass(
    `${namePrefix}-efs-sc`,
    {
      metadata: { name: STORAGE_CLASS_NAME },
      provisioner: "efs.csi.aws.com",
      parameters: {
        provisioningMode: "efs-ap",
        fileSystemId: fileSystem.id,
        directoryPerms: "700",
        basePath: "/dynamic",
        ensureUniqueDirectory: "true",
      },
      // Keep user-uploaded data if a PVC is deleted.
      reclaimPolicy: "Retain",
      volumeBindingMode: "Immediate",
    },
    { provider: eks.provider, dependsOn: [efsAddon] },
  );

  return { fileSystem, storageClass, storageClassName: STORAGE_CLASS_NAME };
}
