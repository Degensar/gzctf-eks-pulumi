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
