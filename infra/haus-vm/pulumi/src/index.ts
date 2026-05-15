/**
 * Pulumi TypeScript program for the haus.matthewstevens.org Hermes VM.
 *
 * Scope of this scaffold: provision the Scaleway Container Registry pull
 * reference and the Scaleway Instance (or Serverless Container) that runs the
 * widget-bridge OCI image, and write the Cloudflare DNS record for
 * haus.matthewstevens.org pointing at the new endpoint.
 *
 * This file is intentionally an outline: it documents the shape of the prod
 * stack without provisioning anything yet. The deploy gate from the Testing ->
 * Production Pipeline rule means the prod stack MUST NOT be `pulumi up`'d
 * until the staging stack on the NAS has passed parity tests against the
 * legacy bridge.ts caller.
 */

import * as pulumi from "@pulumi/pulumi";
// NOTE: imports left as comments so `tsc --noEmit` does not fail before deps
// are installed in CI. Uncomment as you wire each resource type.
// import * as scaleway from "@pulumi/scaleway";

const cfg = new pulumi.Config();
const haus = new pulumi.Config("haus");

const image = haus.get("image") ?? "rg.fr-par.scw.cloud/sanmarcsoft/haus-vm:scaffold";
const bridgeToken = haus.requireSecret("bridge-token");
const region = cfg.get("scaleway:region") ?? "fr-par";

// -- Outline only: each section below documents the resource we will create.
//    Implementation is deferred to the first deploy iteration after staging
//    parity tests pass.

// 1) Scaleway Serverless Container running the widget-bridge OCI image.
//    Rationale: serverless container scales to zero when idle (matches the
//    "runs anywhere, costs nearly nothing when idle" property highlighted in
//    the Hermes Agent docs). For a single-tenant chat shim this is cheaper
//    than a long-lived Instance and avoids exposing an SSH surface.
//
//    Example shape (to be enabled when the image is pushed):
//
//      const ns = new scaleway.ContainerNamespace("haus-ns", { region });
//      const container = new scaleway.Container("haus-widget-bridge", {
//        namespaceId: ns.id,
//        registryImage: image,
//        port: 8080,
//        cpuLimit: 500,
//        memoryLimit: 512,
//        minScale: 0,
//        maxScale: 2,
//        environmentVariables: { HERMES_MODE: "stub" },
//        secretEnvironmentVariables: { BRIDGE_TOKEN: bridgeToken },
//        deploy: true,
//      });

// 2) Cloudflare DNS record for haus.matthewstevens.org pointing at the
//    serverless container hostname. (Cloudflare provider, not Scaleway.)
//    Per the "Stays on Cloudflare" exemption in the SOP, DNS continues to
//    live in Cloudflare even though the workload moves to Scaleway.

// 3) Scaleway Object Storage bucket for Hermes profile state, if we decide
//    to persist profile memory across container cold-starts. Not required
//    in 0.1.0 (stub) — profiles are ephemeral.

// Outputs that the deploy pipeline reads.
export const imageRef = image;
export const targetRegion = region;
export const bridgeTokenConfigured = bridgeToken.apply((t) => t.length > 0);
