import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import { Cache } from "./cache";
import { ClusterResources } from "./cluster";
import { gzctf as gzctfCfg, namePrefix } from "./config";
import { Database } from "./database";
import { Storage } from "./storage";

/**
 * The GZCTF platform workload and everything it needs inside Kubernetes:
 * namespaces, an RBAC-scoped ServiceAccount it uses (via in-cluster auth) to
 * launch challenge containers, its configuration Secret, persistent storage,
 * the Deployment/Service, and an ALB Ingress.
 */
export interface Gzctf {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  ingress: k8s.networking.v1.Ingress;
  /** ALB DNS name once provisioned (empty until the LB controller reconciles). */
  ingressHostname: pulumi.Output<string>;
  /** Initial admin password (secret). */
  adminPassword: pulumi.Output<string>;
}

export function createGzctf(
  eks: ClusterResources,
  db: Database,
  cache: Cache,
  storage: Storage,
): Gzctf {
  const provider = eks.provider;
  const opts = { provider };
  const labels = { "app.kubernetes.io/name": "gzctf" };

  // --- Namespaces ----------------------------------------------------------
  const platformNs = new k8s.core.v1.Namespace(
    `${namePrefix}-ns`,
    { metadata: { name: gzctfCfg.platformNamespace } },
    opts,
  );
  const challengeNs = new k8s.core.v1.Namespace(
    `${namePrefix}-challenge-ns`,
    { metadata: { name: gzctfCfg.challengeNamespace } },
    opts,
  );

  // --- ServiceAccount + RBAC ----------------------------------------------
  // GZCTF authenticates to the API server with this SA's in-cluster token.
  const sa = new k8s.core.v1.ServiceAccount(
    `${namePrefix}-gzctf-sa`,
    { metadata: { namespace: gzctfCfg.platformNamespace, name: "gzctf" } },
    { provider, dependsOn: [platformNs] },
  );

  const saSubject = {
    kind: "ServiceAccount",
    name: "gzctf",
    namespace: gzctfCfg.platformNamespace,
  };

  // Cluster-scoped: GZCTF lists namespaces and creates the challenge namespace
  // if it is missing.
  const nsClusterRole = new k8s.rbac.v1.ClusterRole(
    `${namePrefix}-gzctf-ns`,
    {
      metadata: { name: "gzctf-namespace-manager" },
      rules: [
        {
          apiGroups: [""],
          resources: ["namespaces"],
          verbs: ["get", "list", "watch", "create"],
        },
      ],
    },
    opts,
  );
  new k8s.rbac.v1.ClusterRoleBinding(
    `${namePrefix}-gzctf-ns`,
    {
      metadata: { name: "gzctf-namespace-manager" },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "gzctf-namespace-manager",
      },
      subjects: [saSubject],
    },
    { provider, dependsOn: [nsClusterRole, sa] },
  );

  // Namespaced: full control over the challenge workloads GZCTF manages.
  const challengeRole = new k8s.rbac.v1.Role(
    `${namePrefix}-gzctf-challenge`,
    {
      metadata: {
        namespace: gzctfCfg.challengeNamespace,
        name: "gzctf-challenge-manager",
      },
      rules: [
        {
          apiGroups: [""],
          resources: [
            "pods",
            "pods/log",
            "pods/exec",
            "services",
            "secrets",
            "configmaps",
            "events",
          ],
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
        },
        {
          apiGroups: ["networking.k8s.io"],
          resources: ["networkpolicies"],
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
        },
      ],
    },
    { provider, dependsOn: [challengeNs] },
  );
  const challengeRoleBinding = new k8s.rbac.v1.RoleBinding(
    `${namePrefix}-gzctf-challenge`,
    {
      metadata: {
        namespace: gzctfCfg.challengeNamespace,
        name: "gzctf-challenge-manager",
      },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "gzctf-challenge-manager",
      },
      subjects: [saSubject],
    },
    { provider, dependsOn: [challengeRole, sa] },
  );

  // --- Configuration secret (appsettings.json) -----------------------------
  const appsettings = pulumi
    .all([db.connectionString, cache.connectionString])
    .apply(([database, redis]) =>
      JSON.stringify(
        {
          AllowedHosts: "*",
          ConnectionStrings: { Database: database, RedisCache: redis },
          Logging: {
            LogLevel: {
              Default: "Information",
              "Microsoft.AspNetCore": "Warning",
              "Microsoft.EntityFrameworkCore": "Warning",
            },
          },
          // Real client IPs arrive via the ALB; trust the VPC range.
          ForwardedOptions: {
            ForwardedHeaders: "All",
            ForwardLimit: 2,
            TrustedNetworks: ["10.0.0.0/8"],
          },
          ContainerProvider: {
            Type: "Kubernetes",
            PublicEntry: gzctfCfg.publicEntry,
            // Proxy challenge TCP over WebSocket so private-subnet nodes need
            // no public port exposure.
            PortMappingType: "PlatformProxy",
            EnableTrafficCapture: false,
            KubernetesConfig: {
              Namespace: gzctfCfg.challengeNamespace,
              // Empty => use the in-cluster ServiceAccount for auth.
              KubeConfig: "",
              // Block challenge egress to internal ranges + instance metadata.
              AllowCidr: [
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "169.254.169.254/32",
              ],
              // External resolvers so "open" challenges can still use DNS.
              Dns: ["1.1.1.1", "1.0.0.1"],
            },
          },
          RequestLogging: false,
          DisableRateLimit: false,
        },
        null,
        2,
      ),
    );

  const appsettingsSecret = new k8s.core.v1.Secret(
    `${namePrefix}-gzctf-appsettings`,
    {
      metadata: {
        namespace: gzctfCfg.platformNamespace,
        name: "gzctf-appsettings",
      },
      stringData: { "appsettings.json": appsettings },
    },
    { provider, dependsOn: [platformNs] },
  );

  // --- Admin password secret ----------------------------------------------
  const generatedAdmin = new random.RandomPassword(`${namePrefix}-gzctf-admin`, {
    length: 20,
    special: true,
    overrideSpecial: "!#$%^&*-_=+",
  });
  const adminPassword = pulumi.secret(
    gzctfCfg.adminPassword ?? generatedAdmin.result,
  );
  const adminSecret = new k8s.core.v1.Secret(
    `${namePrefix}-gzctf-admin`,
    {
      metadata: { namespace: gzctfCfg.platformNamespace, name: "gzctf-admin" },
      stringData: { GZCTF_ADMIN_PASSWORD: adminPassword },
    },
    { provider, dependsOn: [platformNs] },
  );

  // --- Persistent storage for /app/files -----------------------------------
  const filesPvc = new k8s.core.v1.PersistentVolumeClaim(
    `${namePrefix}-gzctf-files`,
    {
      metadata: { namespace: gzctfCfg.platformNamespace, name: "gzctf-files" },
      spec: {
        accessModes: ["ReadWriteMany"],
        storageClassName: storage.storageClassName,
        resources: { requests: { storage: gzctfCfg.filesStorageSize } },
      },
    },
    { provider, dependsOn: [platformNs, storage.storageClass] },
  );

  // --- Deployment ----------------------------------------------------------
  const deployment = new k8s.apps.v1.Deployment(
    `${namePrefix}-gzctf`,
    {
      metadata: {
        namespace: gzctfCfg.platformNamespace,
        name: "gzctf",
        labels,
      },
      spec: {
        replicas: gzctfCfg.replicas,
        selector: { matchLabels: labels },
        // Avoid two schema/migration versions running at once on upgrade.
        strategy: { type: "Recreate" },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: "gzctf",
            containers: [
              {
                name: "gzctf",
                image: gzctfCfg.image,
                imagePullPolicy: "IfNotPresent",
                ports: [{ name: "http", containerPort: 8080 }],
                env: [
                  {
                    name: "GZCTF_ADMIN_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: "gzctf-admin",
                        key: "GZCTF_ADMIN_PASSWORD",
                      },
                    },
                  },
                ],
                volumeMounts: [
                  {
                    name: "appsettings",
                    mountPath: "/app/appsettings.json",
                    subPath: "appsettings.json",
                    readOnly: true,
                  },
                  { name: "files", mountPath: "/app/files" },
                ],
                // Gate liveness/readiness until first-boot DB migrations
                // finish — up to ~5 minutes against a cold database.
                startupProbe: {
                  httpGet: { path: "/healthz", port: 8080 },
                  periodSeconds: 10,
                  failureThreshold: 30,
                },
                readinessProbe: {
                  httpGet: { path: "/healthz", port: 8080 },
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/healthz", port: 8080 },
                  periodSeconds: 20,
                },
                resources: {
                  requests: { cpu: "250m", memory: "512Mi" },
                  limits: { cpu: "1", memory: "1Gi" },
                },
              },
            ],
            volumes: [
              {
                name: "appsettings",
                secret: { secretName: "gzctf-appsettings" },
              },
              {
                name: "files",
                persistentVolumeClaim: { claimName: "gzctf-files" },
              },
            ],
          },
        },
      },
    },
    {
      provider,
      dependsOn: [
        appsettingsSecret,
        adminSecret,
        filesPvc,
        sa,
        challengeRoleBinding,
        challengeNs,
      ],
    },
  );

  // --- Service -------------------------------------------------------------
  const service = new k8s.core.v1.Service(
    `${namePrefix}-gzctf`,
    {
      metadata: { namespace: gzctfCfg.platformNamespace, name: "gzctf", labels },
      spec: {
        type: "ClusterIP",
        selector: labels,
        ports: [{ name: "http", port: 80, targetPort: 8080 }],
      },
    },
    { provider, dependsOn: [platformNs] },
  );

  // --- Ingress (ALB) -------------------------------------------------------
  const annotations: Record<string, string> = {
    "alb.ingress.kubernetes.io/scheme": "internet-facing",
    "alb.ingress.kubernetes.io/target-type": "ip",
    "alb.ingress.kubernetes.io/healthcheck-path": "/healthz",
  };
  if (gzctfCfg.acmCertificateArn) {
    annotations["alb.ingress.kubernetes.io/listen-ports"] =
      '[{"HTTP":80},{"HTTPS":443}]';
    annotations["alb.ingress.kubernetes.io/certificate-arn"] =
      gzctfCfg.acmCertificateArn;
    annotations["alb.ingress.kubernetes.io/ssl-redirect"] = "443";
  } else {
    annotations["alb.ingress.kubernetes.io/listen-ports"] = '[{"HTTP":80}]';
  }

  const ingress = new k8s.networking.v1.Ingress(
    `${namePrefix}-gzctf`,
    {
      metadata: {
        namespace: gzctfCfg.platformNamespace,
        name: "gzctf",
        annotations,
      },
      spec: {
        ingressClassName: "alb",
        rules: [
          {
            host: gzctfCfg.domainName || undefined,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: { name: "gzctf", port: { number: 80 } },
                  },
                },
              ],
            },
          },
        ],
      },
    },
    { provider, dependsOn: [service] },
  );

  const ingressHostname = ingress.status.loadBalancer.ingress.apply(
    (entries) => entries?.[0]?.hostname ?? "",
  );

  return { deployment, service, ingress, ingressHostname, adminPassword };
}
