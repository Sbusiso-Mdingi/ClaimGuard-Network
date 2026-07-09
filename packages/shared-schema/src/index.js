import { z } from "zod";

export const backendServiceNameSchema = z.literal("api");

export const backendHealthSchema = z.object({
  status: z.literal("ok"),
  service: backendServiceNameSchema,
  phase: z.literal("3"),
  timestamp: z.string(),
});

export const backendInfoSchema = z.object({
  service: backendServiceNameSchema,
  phase: z.literal("3"),
  name: z.string(),
});

export const trpcPingResponseSchema = z.object({
  service: backendServiceNameSchema,
  message: z.string(),
});

export function createBackendHealth(service = "api") {
  return backendHealthSchema.parse({
    status: "ok",
    service,
    phase: "3",
    timestamp: new Date().toISOString(),
  });
}

export function createBackendInfo(name = "ClaimGuard API") {
  return backendInfoSchema.parse({
    service: "api",
    phase: "3",
    name,
  });
}