import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { baseTags } from "./config";

/**
 * Arguments for {@link createIrsaRole}.
 *
 * IRSA ("IAM Roles for Service Accounts") lets a Kubernetes ServiceAccount
 * assume an AWS IAM role via the cluster's OIDC provider, instead of handing
 * AWS credentials to pods. The trust policy ties the role to a specific
 * `namespace/serviceAccountName` pair.
 */
export interface IrsaRoleArgs {
  /** ARN of the cluster's IAM OIDC provider. */
  oidcProviderArn: pulumi.Input<string>;
  /** Issuer URL of the cluster's IAM OIDC provider (with or without scheme). */
  oidcProviderUrl: pulumi.Input<string>;
  /** Namespace of the Kubernetes ServiceAccount that will assume the role. */
  namespace: string;
  /** Name of the Kubernetes ServiceAccount that will assume the role. */
  serviceAccountName: string;
  /** Managed/customer IAM policy ARNs to attach to the role. */
  policyArns: pulumi.Input<string>[];
}

/**
 * Creates an IAM role assumable by a specific Kubernetes ServiceAccount through
 * the cluster's OIDC provider, with the given policies attached.
 */
export function createIrsaRole(name: string, args: IrsaRoleArgs): aws.iam.Role {
  const assumeRolePolicy = pulumi
    .all([args.oidcProviderArn, args.oidcProviderUrl])
    .apply(([arn, url]) => {
      // The condition keys use the issuer host/path without the URL scheme.
      const host = url.replace(/^https?:\/\//, "");
      return JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: arn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                [`${host}:sub`]: `system:serviceaccount:${args.namespace}:${args.serviceAccountName}`,
                [`${host}:aud`]: "sts.amazonaws.com",
              },
            },
          },
        ],
      });
    });

  const role = new aws.iam.Role(`${name}-role`, {
    assumeRolePolicy,
    tags: { ...baseTags, Name: `${name}-role` },
  });

  args.policyArns.forEach((policyArn, i) => {
    new aws.iam.RolePolicyAttachment(`${name}-attach-${i}`, {
      role: role.name,
      policyArn,
    });
  });

  return role;
}
