import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

import { ClusterResources } from "./cluster";
import { baseTags, loadBalancer as lbCfg, namePrefix } from "./config";
import albPolicyDoc from "./iam/aws-load-balancer-controller-policy.json";
import { createIrsaRole } from "./irsa";
import { Network } from "./network";

/**
 * Installs the AWS Load Balancer Controller via Helm. The controller watches
 * Kubernetes `Ingress` objects and provisions ALBs for them, which is how the
 * GZCTF web UI is exposed (with optional ACM TLS) in PR #5.
 *
 * The controller's ServiceAccount assumes an IRSA role bound to the canonical
 * IAM policy published with the controller release (vendored under
 * `src/iam/`), so its pods get exactly the permissions they need and nothing
 * more.
 */
export interface LoadBalancerController {
  release: k8s.helm.v3.Release;
  serviceAccountName: string;
}

const SERVICE_ACCOUNT = "aws-load-balancer-controller";

export function installLoadBalancerController(
  net: Network,
  eks: ClusterResources,
): LoadBalancerController {
  const policy = new aws.iam.Policy(`${namePrefix}-alb-policy`, {
    description: "Permissions for the AWS Load Balancer Controller",
    policy: JSON.stringify(albPolicyDoc),
    tags: baseTags,
  });

  const role = createIrsaRole(`${namePrefix}-alb`, {
    oidcProviderArn: eks.oidcProviderArn,
    oidcProviderUrl: eks.oidcProviderUrl,
    namespace: "kube-system",
    serviceAccountName: SERVICE_ACCOUNT,
    policyArns: [policy.arn],
  });

  const release = new k8s.helm.v3.Release(
    `${namePrefix}-alb`,
    {
      chart: "aws-load-balancer-controller",
      version: lbCfg.chartVersion,
      repositoryOpts: { repo: "https://aws.github.io/eks-charts" },
      namespace: "kube-system",
      values: {
        clusterName: eks.clusterName,
        vpcId: net.vpcId,
        // Omitted region falls back to controller auto-detection via IMDS.
        region: aws.config.region,
        serviceAccount: {
          create: true,
          name: SERVICE_ACCOUNT,
          annotations: {
            "eks.amazonaws.com/role-arn": role.arn,
          },
        },
      },
    },
    { provider: eks.provider },
  );

  return { release, serviceAccountName: SERVICE_ACCOUNT };
}
