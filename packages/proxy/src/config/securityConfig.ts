import { z } from "zod";

export const tokenSourceSchema = z.union([
  z.object({ value: z.string().min(8) }),
  z.object({ env: z.string().min(1) }),
]);

export const upstreamProfileSchema = z.object({
  name: z.string().min(1),
  adapter: z.literal("websocket"),
  url: z.string().url(),
  allowedHeaders: z.array(z.string()).default([]),
  allowPrivateNetwork: z.boolean().default(false),
});

export const corsConfigSchema = z.object({
  allowedOrigins: z.array(z.string()).default([]),
  allowCredentials: z.boolean().default(false),
});

export const securityConfigSchema = z.object({
  requireAuth: z.boolean().default(true),
  tokens: z.array(tokenSourceSchema).default([]),
  cors: corsConfigSchema.default({ allowedOrigins: [], allowCredentials: false }),
  upstreamPolicy: z
    .object({
      default: z.enum(["deny", "allow"]).default("deny"),
      allow: z.array(upstreamProfileSchema).default([]),
      allowDirectUrl: z.boolean().default(false),
    })
    .default({ default: "deny", allow: [], allowDirectUrl: false }),
});

export type SecurityConfig = z.infer<typeof securityConfigSchema>;
export type UpstreamProfile = z.infer<typeof upstreamProfileSchema>;
